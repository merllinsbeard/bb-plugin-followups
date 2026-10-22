// Shared by the test files that run the plugin on the SDK's fake host (not a test itself:
// `npm test` only picks up *.test.mjs). `boot` gives a fake BB with threads, their turn
// events and plugin metadata, and puts the fake `claude` (tests/fake-claude) first on PATH.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakePluginHost, makeMessageDispatchHookContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll `condition` every 10ms until it is true; fail the test if it still isn't after `ms`. */
export async function until(condition, ms = 5000) {
  for (let waited = 0; waited < ms; waited += 10) {
    if (await condition()) return;
    await sleep(10);
  }
  assert.fail("timed out waiting for: " + condition);
}

/** Whether the process `pid` is still running. */
export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const FAKE_BIN = fileURLToPath(new URL("./fake-claude", import.meta.url));

export const CANDIDATES = [
  { label: "Add a test for the empty queue", why: "The answer says the empty queue is untested", kind: "check" },
  { label: "Commit the fix", why: "The fix is done and its tests pass", kind: "close" },
  { label: "Retry path next", why: "The answer names the retry path as the next step", kind: "continue" },
  { label: "Split the parser into its own thread", why: "The parser work is independent of the fix", kind: "delegate" },
];
export const DRAFT = "Please add a test for the empty queue case.";

/**
 * A valid suggestion answer: these labels first (strings, or `{ label, why, kind }`), filled up
 * to the four candidates the schema requires from CANDIDATES.
 */
export function suggested(...firsts) {
  const own = firsts.map((item) => ({ kind: "continue", why: `Because of ${typeof item === "string" ? item : item.label}`, ...(typeof item === "string" ? { label: item } : item) }));
  const rest = CANDIDATES.filter((candidate) => !own.some((item) => item.label === candidate.label));
  return { candidates: [...own, ...rest].slice(0, 4), cardStale: false };
}

/**
 * Put the fake `claude` first on PATH with a fresh directory for its call log and answers.
 * `answer(fixtures)` replaces what it answers (see tests/fake-claude/claude); `calls(kind)`
 * reads what it was sent; `open(name)` releases the calls gated on `gate(name)`.
 */
export async function fakeClaude(fixtures) {
  const dir = await mkdtemp(join(tmpdir(), "followups-claude-"));
  process.env.FAKE_CLAUDE_DIR = dir;
  if (!process.env.PATH.split(delimiter).includes(FAKE_BIN)) process.env.PATH = `${FAKE_BIN}${delimiter}${process.env.PATH}`;
  const answer = (next) => writeFileSync(join(dir, "fixtures.json"), JSON.stringify(next));
  answer(fixtures);
  return {
    dir,
    answer,
    calls(kind) {
      const log = join(dir, "calls.jsonl");
      if (!existsSync(log)) return [];
      const all = readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
      return kind ? all.filter((call) => call.kind === kind) : all;
    },
    gate: (name) => join(dir, `gate-${name}`),
    open: (name) => writeFileSync(join(dir, `gate-${name}`), ""),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/** The value of `--flag` in a recorded call's argv. */
export function flag(call, name) {
  const at = call.argv.indexOf(name);
  return at === -1 ? undefined : call.argv[at + 1];
}

const defaultAnswers = () => ({
  suggest: { output: suggested() },
  draft: { output: { message: DRAFT } },
});

/**
 * A fake BB. `threads` maps id -> { status, parent, visibility, title, projectId, sectionId,
 * originPluginId, environmentId, answer, turns }. `turns` are the thread's turn requests,
 * `{ initiator, source, sender, text }`; by default one `user`/`spawn` turn that started it
 * (an owner's for a root thread, an agent's spawn for a child). `claude` overrides the fake
 * claude's answers; `metadata` seeds stored plugin metadata (`{ [pluginId]: { [threadId]: … } }`
 * or, for this plugin, `{ [threadId]: … }`).
 */
export async function boot({ threads = { t1: {} }, settings = {}, claude = {}, metadata = {}, now = Date.now() } = {}) {
  const fake = await fakeClaude({ ...defaultAnswers(), ...claude });
  const world = {
    threads: {},
    metadata: { followups: {} },
    events: {},
    seq: 0,
    spawned: 0,
    archived: [],
    deleted: [],
    listCalls: [],
    getCalls: [],
    listFails: false,
    eventsFails: false,
    metadataWrites: 0,
    metadataFails: false,
  };
  for (const [key, value] of Object.entries(metadata)) {
    if (key === "followups" || key.startsWith("plugin:")) world.metadata[key.replace(/^plugin:/, "")] = structuredClone(value);
    else world.metadata.followups[key] = structuredClone(value);
  }
  const addTurn = (id, { initiator = "user", source = "tell", sender = null, text = "", at = Date.now() } = {}) => {
    world.seq += 1;
    (world.events[id] ??= []).push({
      seq: world.seq,
      createdAt: at,
      type: "client/turn/requested",
      threadId: id,
      data: { initiator, source, senderThreadId: sender, input: [{ type: "text", text }] },
    });
  };
  const addThread = (id, spec = {}) => {
    world.threads[id] = {
      status: "idle",
      parent: null,
      visibility: "visible",
      title: id,
      projectId: "p",
      sectionId: null,
      originPluginId: null,
      environmentId: "e",
      archivedAt: null,
      createdAt: now - 3_600_000,
      updatedAt: now - 60_000,
      answer: `${id}'s answer.`,
      ...spec,
    };
    const turns = spec.turns ?? [{ initiator: "user", source: "spawn", text: `${id}: please do the task.` }];
    for (const turn of turns) addTurn(id, { at: now - 3_000_000, ...turn });
  };
  for (const [id, spec] of Object.entries(threads)) addThread(id, spec);

  const row = (id) => {
    const t = world.threads[id];
    return makeThreadResponse({
      id,
      status: t.status,
      parentThreadId: t.parent,
      visibility: t.visibility,
      title: t.title,
      projectId: t.projectId,
      sectionId: t.sectionId,
      originPluginId: t.originPluginId,
      environmentId: t.environmentId,
      archivedAt: t.archivedAt,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    });
  };
  const metaOf = (pluginId, threadId) => (world.metadata[pluginId] ??= {})[threadId] ?? {};
  const live = (id) => world.threads[id].archivedAt === null && world.threads[id].visibility === "visible";

  const host = createFakePluginHost({
    pluginId: "followups",
    settings,
    agentSkillIds: ["followups"],
    sdk: {
      threads: {
        getPluginMetadata: async ({ threadId, pluginId = "followups" }) => {
          if (world.metadataFails) throw new Error("metadata is down");
          return structuredClone(metaOf(pluginId, threadId));
        },
        updatePluginMetadata: async ({ threadId, pluginId = "followups", set = {}, remove = [] }) => {
          if (world.metadataFails) throw new Error("metadata is down");
          world.metadataWrites += 1;
          const next = { ...metaOf(pluginId, threadId), ...structuredClone(set) };
          for (const key of remove) delete next[key];
          world.metadata[pluginId][threadId] = next;
          return {};
        },
        experimental_listPluginMetadata: async ({ pluginId, threadIds }) =>
          threadIds
            .filter((id) => Object.keys(metaOf(pluginId, id)).length > 0)
            .map((id) => ({ threadId: id, metadata: structuredClone(metaOf(pluginId, id)) })),
        get: async ({ threadId }) => {
          world.getCalls.push(threadId);
          if (!world.threads[threadId]) throw new Error(`no such thread ${threadId}`);
          return row(threadId);
        },
        list: async (args = {}) => {
          world.listCalls.push(args);
          if (world.listFails) throw new Error("list is down");
          const ids = Object.keys(world.threads);
          if (args.parentThreadId) return ids.filter((id) => world.threads[id].parent === args.parentThreadId).map(row);
          if (args.originPluginId) {
            return ids
              .filter((id) => world.threads[id].originPluginId === args.originPluginId)
              .filter((id) => (world.threads[id].archivedAt !== null) === Boolean(args.archived))
              .slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 100))
              .map(row);
          }
          return ids
            .filter(live)
            .filter((id) => args.environmentId === undefined || world.threads[id].environmentId === args.environmentId)
            .filter((id) => args.projectId === undefined || world.threads[id].projectId === args.projectId)
            .filter((id) => args.sectionId === undefined || world.threads[id].sectionId === args.sectionId)
            .sort((a, b) => world.threads[b].updatedAt - world.threads[a].updatedAt)
            .slice(0, args.limit ?? 100)
            .map(row);
        },
        output: async ({ threadId }) => ({ output: world.threads[threadId]?.answer ?? "" }),
        promptHistory: async ({ threadId, limit }) =>
          (world.events[threadId] ?? [])
            .filter((event) => event.data.initiator === "user" && event.data.senderThreadId === null)
            .reverse()
            .slice(0, Number(limit ?? 20))
            .map((event) => ({ input: event.data.input })),
        events: {
          list: async ({ threadId, types, afterSeq, order = "asc", limit = "100" }) => {
            if (world.eventsFails) throw new Error("events are down");
            let rows = (world.events[threadId] ?? []).filter((event) => !types || types.includes(event.type));
            if (afterSeq !== undefined) rows = rows.filter((event) => event.seq > Number(afterSeq));
            if (order === "desc") rows = [...rows].reverse();
            return structuredClone(rows.slice(0, Number(limit)));
          },
        },
        spawn: async () => {
          world.spawned += 1;
          return { id: `spawned${world.spawned}` };
        },
        archive: async ({ threadId }) => {
          world.archived.push(threadId);
          if (world.threads[threadId]) world.threads[threadId].archivedAt = Date.now();
          return {};
        },
        delete: async ({ threadId }) => {
          world.deleted.push(threadId);
          delete world.threads[threadId];
          return { ok: true };
        },
        stop: async () => ({}),
      },
    },
  });
  await plugin(host.bb);
  const rpc = (name, input) => host.harness.callRpc(name, input);
  const emit = (event, payload) => host.harness.emitThreadEvent(event, payload);
  return {
    world,
    host,
    row,
    rpc,
    claude: fake,
    addThread,
    addTurn,
    shown: (id = "t1") => rpc("followups_get", { threadId: id }),
    setEnabled: (enabled, id = "t1") => rpc("followups_set_enabled", { threadId: id, enabled }),
    cli: (...argv) => host.harness.runCli(argv),
    logs: () => host.harness.logEntries.map((entry) => entry.message),
    warnings: () => host.harness.logEntries.filter((entry) => entry.level === "warn").map((entry) => entry.message),
    meta: (id = "t1", pluginId = "followups") => metaOf(pluginId, id),
    idle: (id = "t1", text) => {
      world.threads[id].status = "idle";
      return emit("thread.idle", { thread: row(id), lastAssistantText: text ?? world.threads[id].answer });
    },
    active: (id = "t1") => {
      world.threads[id].status = "active";
      return emit("thread.active", { thread: row(id) });
    },
    /** The owner sends `text` to a thread: a user turn is requested and the thread starts working. */
    say: (id, text) => {
      addTurn(id, { text });
      world.threads[id].status = "active";
      return emit("thread.active", { thread: row(id) });
    },
    event: (name, payload) => emit(name, payload),
    dispatch: (overrides) => host.harness.registrations.hooks["message.dispatch"](makeMessageDispatchHookContext(overrides)),
    async untilReady(id = "t1") {
      await until(async () => (await rpc("followups_get", { threadId: id })).status === "ready");
    },
    async dispose() {
      await host.harness.dispose();
      await fake.cleanup();
    },
  };
}

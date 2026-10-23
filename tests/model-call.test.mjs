import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { z } from "zod";
import { callModel, ModelCallError, readModelChoice } from "../lib/model.ts";
import { draftOutputSchema, suggestOutputSchema } from "../lib/suggest.ts";
import { cardDraftSchema } from "../lib/card.ts";
import { alive, boot, CARD_DRAFT, DRAFT, fakeModel, flag, suggested, until } from "./helpers.mjs";

const choices = ["gpt-6-luna", "claude-haiku-5-5"];
const call = (model, overrides = {}) => ({
  purpose: "draft", choice: readModelChoice({ model, effort: "high" }), system: "Write a message.",
  prompt: "Source material: Привет 🐈", output: draftOutputSchema, access: { kind: "none" }, timeoutMs: 5000, ...overrides,
});
const fails = (failure) => (error) => error instanceof ModelCallError && error.failure === failure;
const dead = (pid) => !alive(pid) || /State:\s+Z/.test(readFileSync(`/proc/${pid}/status`, "utf8"));

for (const model of choices) {
  test(`${model} returns typed output, usage, and removes its private files`, async (t) => {
    const fake = await fakeModel({ draft: { output: { message: "Привет 🐈" }, chunked: true } });
    t.after(() => fake.cleanup());
    const result = await callModel(call(model));
    assert.deepEqual(result.value, { message: "Привет 🐈" });
    const provider = model.startsWith("gpt-") ? "codex" : "claude";
    assert.equal(result.stats.model, `${provider === "codex" ? "codex" : "claude-code"}/${model}@high`);
    assert.equal(result.stats.inputTokens, 1000);
    assert.equal(result.stats.cachedInputTokens, 2000);
    assert.equal(result.stats.outputTokens, 300);
    assert.equal(result.stats.reasoningOutputTokens, 200);
    assert.equal(result.stats.turns, provider === "claude" ? 2 : undefined);
    const [record] = fake.calls();
    assert.equal(record.provider, provider);
    assert.equal(record.stdin, "Source material: Привет 🐈");
    assert.ok(!record.argv.some((arg) => arg.includes("Source material:")));
    assert.match(record.system, /Write a message\./);
    assert.equal(record.bbIdentityPresent, false);
    assert.equal(existsSync(dirname(record.cwd)), false);
  });

  for (const [fixture, failure] of [
    [{ fail: "exit" }, "model-error"], [{ fail: "is_error" }, "model-error"],
    [{ output: { message: DRAFT }, exitCode: 7 }, "model-error"], [{ output: { message: "" } }, "bad-output"],
  ]) {
    test(`${model} rejects ${JSON.stringify(fixture)}`, async (t) => {
      const fake = await fakeModel({ draft: fixture });
      t.after(() => fake.cleanup());
      await assert.rejects(callModel(call(model)), fails(failure));
      assert.equal(existsSync(dirname(fake.calls()[0].cwd)), false);
    });
  }

  test(`${model} reports the missing selected executable`, async (t) => {
    const fake = await fakeModel({});
    t.after(() => fake.cleanup());
    const path = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try { await assert.rejects(callModel(call(model)), fails("missing-cli")); }
    finally { process.env.PATH = path; }
    assert.deepEqual(fake.calls(), []);
  });

  for (const failure of ["timeout", "aborted"]) {
    test(`${model} kills its descendant on ${failure} before cleanup`, async (t) => {
      const fake = await fakeModel({ draft: { output: { message: DRAFT }, spawnChild: true, delayMs: 10000 } });
      t.after(() => fake.cleanup());
      const abort = new AbortController();
      const promise = callModel(call(model, { timeoutMs: failure === "timeout" ? 600 : 5000, signal: abort.signal }));
      const rejection = assert.rejects(promise, fails(failure));
      await until(() => fake.calls().length === 1);
      const record = fake.calls()[0];
      assert.ok(record.childPid);
      if (failure === "aborted") abort.abort();
      await rejection;
      await until(() => dead(record.pid) && dead(record.childPid));
      assert.equal(existsSync(dirname(record.cwd)), false);
    });
  }

  test(`${model} never spawns for a pre-aborted call`, async (t) => {
    const fake = await fakeModel({});
    t.after(() => fake.cleanup());
    await assert.rejects(callModel(call(model, { signal: AbortSignal.abort() })), fails("aborted"));
    assert.deepEqual(fake.calls(), []);
  });

  test(`${model} drives suggestions, drafting and cards through the public plugin`, async (t) => {
    const w = await boot({ settings: { model, card: false } });
    t.after(() => w.dispose());
    await w.idle();
    await w.untilReady();
    const picked = (await w.shown()).suggestions[0];
    assert.equal((await w.rpc("followups_expand", { threadId: "t1", id: picked.id })).text, DRAFT);
    await w.host.harness.setSettings({ card: true });
    assert.equal((await w.cli("card", "t1", "--refresh")).exitCode, 0);
    assert.equal(w.meta().card.task, CARD_DRAFT.task);
    assert.deepEqual(w.model.calls().map((entry) => entry.kind).sort(), ["card", "draft", "suggest"]);
    assert.ok(w.model.calls().every((entry) => entry.provider === (model.startsWith("gpt-") ? "codex" : "claude")));
  });
}

for (const [name, fixture, failure] of [
  ["missing completion", { missingCompletion: true }, "model-error"],
  ["missing file", { missingFile: true }, "bad-output"],
  ["empty file", { rawAnswer: "" }, "bad-output"],
  ["invalid file", { rawAnswer: "{" }, "bad-output"],
  ["oversized file", { rawAnswer: "x".repeat(2 * 1024 * 1024 + 1) }, "bad-output"],
  ["oversized stdout", { stdout: "x".repeat(2 * 1024 * 1024 + 1) }, "bad-output"],
  ["malformed JSONL", { stdout: "{" }, "model-error"],
  ["invalid event", { events: [{ type: 2 }] }, "model-error"],
  ["invalid error", { events: [{ type: "error", message: 3 }] }, "model-error"],
  ["error despite valid file", { events: [{ type: "error", message: "provider failure" }] }, "model-error"],
  ["failed turn despite valid file", { events: [{ type: "turn.failed", error: { message: "failed" } }] }, "model-error"],
  ["invalid usage", { usage: { input_tokens: 1, cached_input_tokens: 2 } }, "model-error"],
  ["negative usage", { usage: { input_tokens: -1 } }, "model-error"],
]) {
  test(`Codex rejects ${name}`, async (t) => {
    const fake = await fakeModel({ draft: { output: { message: DRAFT }, ...fixture } });
    t.after(() => fake.cleanup());
    await assert.rejects(callModel(call("gpt-6-luna")), fails(failure));
    assert.equal(existsSync(dirname(fake.calls()[0].cwd)), false);
  });
}

test("Codex uses the final file, ignores unknown events and omits unavailable usage", async (t) => {
  const fake = await fakeModel({ draft: { output: { message: "Final file" }, events: [
    { type: "item.completed", item: { type: "agent_message", text: '{"message":"wrong answer"}' } },
    { type: "future.event" }, { type: "turn.completed", usage: { input_tokens: 1000, output_tokens: 90 } },
  ], chunked: true } });
  t.after(() => fake.cleanup());
  const result = await callModel(call("gpt-6-luna"));
  assert.equal(result.value.message, "Final file");
  assert.equal(result.stats.inputTokens, undefined);
  assert.equal(result.stats.cachedInputTokens, undefined);
  assert.equal(result.stats.outputTokens, 90);
  assert.equal(result.stats.deniedTools, undefined);
});

test("Codex subtracts cached input and keeps reasoning within output", async (t) => {
  const fake = await fakeModel({ draft: { output: { message: DRAFT }, usage: { input_tokens: 1000, cached_input_tokens: 700, output_tokens: 90, reasoning_output_tokens: 40 } } });
  t.after(() => fake.cleanup());
  const { stats } = await callModel(call("gpt-6-luna"));
  assert.equal(stats.inputTokens + stats.cachedInputTokens + stats.outputTokens, 1090);
  assert.equal(stats.reasoningOutputTokens, 40);
});

for (const access of [{ kind: "none" }, { kind: "explore", readDirs: ["/project"], maxTurns: 12, bashTimeoutMs: 12000 }]) {
  test(`Codex ${access.kind} configures native suppression and its private sandbox`, async (t) => {
    const fake = await fakeModel({ draft: { output: { message: DRAFT } } });
    t.after(() => fake.cleanup());
    const before = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, CODEX_API_KEY: process.env.CODEX_API_KEY, BB_SENTINEL: process.env.BB_SENTINEL };
    process.env.OPENAI_API_KEY = "fake-override";
    process.env.CODEX_API_KEY = "fake-override";
    process.env.BB_SENTINEL = "identity";
    try { await callModel(call("gpt-6-luna", { access })); }
    finally { for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    const [record] = fake.calls();
    assert.equal(record.apiKeyPresent, false);
    assert.equal(record.bbIdentityPresent, false);
    assert.ok(record.tmpdir.startsWith(record.cwd + "/"));
    for (const name of ["--ignore-user-config", "--ignore-rules", "--ephemeral", "--json"]) assert.ok(record.argv.includes(name));
    const disabled = record.argv.flatMap((arg, index) => arg === "--disable" ? [record.argv[index + 1]] : []);
    for (const name of ["apps", "plugins", "memories", "skill_search", "tool_suggest", "multi_agent", "multi_agent_v2", "image_generation", "browser_use", "computer_use", "view_image", "goals", "sleep_tool"]) assert.ok(disabled.includes(name), name);
    assert.ok(record.argv.includes('web_search="disabled"'));
    assert.ok(!record.argv.includes("--add-dir"));
    assert.equal(flag(record, "-s"), access.kind === "none" ? "read-only" : "workspace-write");
    if (access.kind === "none") {
      assert.ok(disabled.includes("shell_tool") && disabled.includes("unified_exec"));
      assert.match(record.system, /Use no tools/);
      assert.ok(!record.argv.includes("sandbox_workspace_write.network_access=true"));
    } else {
      for (const config of ["sandbox_workspace_write.network_access=true", "sandbox_workspace_write.exclude_slash_tmp=true", "sandbox_workspace_write.exclude_tmpdir_env_var=true"]) assert.ok(record.argv.includes(config));
      assert.match(record.system, /12000ms/);
      assert.match(record.system, /\/project/);
    }
  });
}

function assertStrict(schema) {
  if (!schema || typeof schema !== "object") return;
  if (schema.type === "object") {
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
  }
  for (const value of Object.values(schema)) for (const child of [value].flat()) assertStrict(child);
}
for (const [purpose, schema, output] of [["suggest", suggestOutputSchema, suggested()], ["draft", draftOutputSchema, { message: DRAFT }], ["card", cardDraftSchema, CARD_DRAFT]]) {
  test(`${purpose} sends a strict API-compatible schema`, async (t) => {
    const fake = await fakeModel({ [purpose]: { output } });
    t.after(() => fake.cleanup());
    assertStrict(z.toJSONSchema(schema, { io: "output" }));
    await callModel(call("gpt-6-luna", { output: schema }));
    assertStrict(fake.calls()[0].schema);
  });
}
test("Codex rejects the optional-property schema like the API", async (t) => {
  const fake = await fakeModel({ draft: { output: { message: DRAFT } } });
  t.after(() => fake.cleanup());
  await assert.rejects(callModel(call("gpt-6-luna", { output: z.object({ message: z.string(), optional: z.string().optional() }).strict() })), (error) => fails("model-error")(error) && /Missing 'optional'/.test(error.message));
});

test("invalid model settings leave registration and card queue working, then recover", async (t) => {
  const w = await boot({ settings: { model: "unknown", card: true, cardRuns: 1 }, threads: { t1: {}, t2: {} } });
  t.after(() => w.dispose());
  assert.equal((await w.cli("model")).exitCode, 1);
  await w.idle();
  await until(() => w.warnings().some((message) => /generate failed/.test(message)));
  for (const id of ["t1", "t2"]) assert.equal((await w.cli("card", id, "--refresh")).exitCode, 0);
  assert.equal(w.meta("t1").cardAttempt.ok, false);
  assert.equal(w.meta("t2").cardAttempt.ok, false);
  assert.deepEqual(w.model.calls(), []);
  await w.host.harness.setSettings({ model: "gpt-6-luna" });
  await w.cli("regenerate", "t1");
  await w.untilReady();
  await w.cli("card", "t2", "--refresh");
  assert.equal(w.meta("t2").cardAttempt.ok, true);
});

test("model name families and aliases resolve without a provider setting", () => {
  for (const model of ["claude-test", "haiku", "sonnet", "opus"]) assert.equal(readModelChoice({ model }).provider, "claude");
  assert.equal(readModelChoice({ model: " gpt-6-luna ", effort: "invalid" }).effort, "max");
  assert.equal(readModelChoice({ model: "" }).model, "gpt-6-luna");
  assert.throws(() => readModelChoice({ model: "other" }), fails("model-error"));
});


test("local I/O failure is a model error and starts no process", async (t) => {
  const fake = await fakeModel({});
  t.after(() => fake.cleanup());
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = join(fake.dir, "fixtures.json");
  try { await assert.rejects(callModel(call("gpt-6-luna")), fails("model-error")); }
  finally { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; }
  assert.deepEqual(fake.calls(), []);
});

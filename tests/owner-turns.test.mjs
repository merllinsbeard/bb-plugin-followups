// Follow-ups are for threads the owner writes in. A thread only agents have written in (a child
// an agent spawned and talks to, a plugin's run) gets none unless it is switched on, and no
// `claude` call is made for it. Run with `npm test`.
import assert from "node:assert/strict";
import test from "node:test";
import { turnAuthor } from "../lib/thread-context.ts";
import { boot, sleep } from "./helpers.mjs";

const calls = (w) => w.claude.calls("suggest").length;
const turn = (initiator, source, sender = null) => ({ seq: 1, at: 0, initiator, source, senderThreadId: sender, text: "" });
const root = { parentThreadId: null, originPluginId: null };
const child = { parentThreadId: "boss", originPluginId: null };
const pluginRun = { parentThreadId: null, originPluginId: "agent-roles" };

test("who wrote a turn, from what bb records about it", () => {
  for (const [name, request, thread, origin, author] of [
    ["the owner types a follow-up", turn("user", "tell"), root, null, "owner"],
    ["the owner types in a child thread", turn("user", "tell"), child, null, "owner"],
    ["an agent's `bb thread tell`", turn("agent", "tell", "thr_boss"), root, null, "agent"],
    ["a child's report", turn("system", "tell"), root, null, "system"],
    ["an agent spawns a child", turn("user", "spawn"), child, null, "agent"],
    ["a plugin starts a thread", turn("user", "spawn"), pluginRun, null, "agent"],
    ["a root thread started before origins were recorded", turn("user", "spawn"), root, null, "owner"],
    ["a root thread started from the CLI", turn("user", "spawn"), root, "cli", "agent"],
    ["a thread started through the SDK", turn("user", "spawn"), root, "sdk", "agent"],
    ["a thread a plugin started", turn("user", "spawn"), root, "plugin", "agent"],
    ["the owner starts a child thread in the app", turn("user", "spawn"), child, "app", "owner"],
    ["a start turn another thread sent", turn("user", "spawn", "thr_boss"), root, "app", "agent"],
  ]) {
    assert.equal(turnAuthor(request, thread, origin), author, name);
  }
});

const agentChild = {
  boss: {},
  kid: {
    parent: "boss",
    turns: [
      { initiator: "user", source: "spawn", text: "Port the parser" },
      { initiator: "agent", source: "tell", sender: "boss", text: "Also cover the empty input" },
      { initiator: "system", source: "tell", text: "Please continue." },
    ],
  },
};

test("a child thread only agents have written in gets no follow-ups, and no call is made", async () => {
  const w = await boot({ threads: agentChild });
  await w.idle("kid");
  await sleep(300);
  assert.equal(calls(w), 0);
  const got = await w.shown("kid");
  assert.equal(got.enabled, false, "its header switch shows off");
  assert.equal(got.status, "empty");
  await w.dispose();
});

test("once the owner writes in that child, it gets follow-ups like any thread", async () => {
  const w = await boot({ threads: agentChild });
  await w.say("kid", "Use the second option");
  await w.idle("kid");
  await w.untilReady("kid");
  assert.equal(calls(w), 1);
  assert.equal((await w.shown("kid")).enabled, true);
  await w.dispose();
});

test("an agent's message after the owner's doesn't take follow-ups away", async () => {
  const w = await boot();
  w.addTurn("t1", { initiator: "agent", sender: "thr_boss", text: "Status?" });
  w.addTurn("t1", { initiator: "system", text: "Please continue." });
  await w.idle();
  await w.untilReady();
  await w.dispose();
});

test("a thread a plugin started gets none", async () => {
  const w = await boot({ threads: { run: { originPluginId: "agent-roles" } } });
  await w.idle("run");
  await sleep(300);
  assert.equal(calls(w), 0);
  await w.dispose();
});

test("the owner's message far down a long history still counts", async () => {
  const turns = [
    { initiator: "user", source: "spawn", text: "Watch the queue" },
    ...Array.from({ length: 250 }, (_, i) => ({ initiator: "agent", source: "tell", sender: "boss", text: `tick ${i}` })),
    { initiator: "user", source: "tell", text: "Stop and summarize" },
  ];
  const w = await boot({ threads: { boss: {}, kid: { parent: "boss", turns } } });
  await w.idle("kid");
  await w.untilReady("kid");
  await w.dispose();
});

test("`bb followups on` gives an agent-only thread follow-ups; `off` beats the owner's own thread", async () => {
  const w = await boot({ threads: { ...agentChild, t1: {} } });
  await w.cli("on", "kid");
  await w.untilReady("kid");
  await w.cli("off", "t1");
  await w.idle("t1");
  await sleep(250);
  assert.equal(calls(w), 1, "only kid was drafted");
  await w.dispose();
});

test("`show` and `regenerate` say a thread is off because only agents wrote in it", async () => {
  const w = await boot({ threads: agentChild });
  assert.match((await w.cli("show", "kid")).stdout, /off because only agents have written in it/);
  const regenerate = await w.cli("regenerate", "kid");
  assert.equal(regenerate.exitCode, 1);
  assert.match(regenerate.stderr, /only agents have written in it/);
  assert.match(regenerate.stderr, /followups on kid/);
  assert.equal(calls(w), 0);
  await w.dispose();
});

test("if the turns can't be read, what was learned before stands, and the failure is logged", async () => {
  const known = { turns: { scannedSeq: 1, lastOwnerSeq: 1, lastOwnerAt: 0 } };
  const w = await boot({ metadata: { t1: known } });
  w.world.eventsFails = true;
  await w.idle();
  await w.untilReady();
  assert.ok(w.warnings().some((m) => /who wrote in t1/.test(m) && /events are down/.test(m)), JSON.stringify(w.logs()));
  await w.dispose();
});

test("a thread whose turns were never read gets none while they can't be", async () => {
  const w = await boot();
  w.world.eventsFails = true;
  await w.idle();
  await sleep(300);
  assert.equal(calls(w), 0);
  assert.match((await w.cli("show", "t1")).stdout, /off until its turns can be read/);
  await w.dispose();
});

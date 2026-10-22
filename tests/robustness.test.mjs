// Edge cases found in a review of the whole plugin: events with nothing to clear, a reload with
// work in flight, unreadable stored metadata, and an "answer" that is really the user's own
// message. Run with `npm test`.
import assert from "node:assert/strict";
import test from "node:test";
import { makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { alive, boot, sleep, until } from "./helpers.mjs";

// t1's turns already read (its start turn is seq 1), so only what a test does writes.
const SCANNED = { turns: { scannedSeq: 1, lastOwnerSeq: 1, lastOwnerAt: 0 } };
const READY = { ...SCANNED, status: "ready", suggestions: [{ id: "a1", label: "Add a test", why: "Untested" }], updatedAt: Date.now() };
const signals = (w) => w.host.harness.realtimeSignals.length;

// ---- events with nothing to clear ----

for (const [name, fire] of [
  ["the thread going active", (w) => w.event("thread.active", { thread: w.row("t1") })],
  ["a message being queued", (w) => w.event("message.queued", { entry: { threadId: "t1" } })],
  ["a message being dispatched", (w) => w.event("message.dispatched", { entry: { threadId: "t1" } })],
]) {
  test(`${name} on a thread with nothing showing writes nothing and broadcasts nothing`, async () => {
    const w = await boot({ metadata: { t1: structuredClone(SCANNED) } });
    const writes = w.world.metadataWrites;
    await fire(w);
    await sleep(100);
    assert.equal(w.world.metadataWrites, writes);
    assert.equal(signals(w), 0);
    await w.dispose();
  });

  test(`${name} on a thread showing follow-ups clears them, once`, async () => {
    const w = await boot({ metadata: { t1: structuredClone(READY) } });
    const writes = w.world.metadataWrites;
    await fire(w);
    await until(async () => (await w.shown()).status === "empty");
    assert.equal(w.world.metadataWrites - writes, 1);
    assert.equal(signals(w), 1);
    assert.ok(w.logs().some((m) => /followups cleared for t1/.test(m)));
    await w.dispose();
  });
}

test("a thread whose call is in flight is cleared too", async () => {
  const w = await boot({ metadata: { t1: { status: "working", suggestions: [], updatedAt: Date.now() } } });
  await w.active();
  await until(async () => (await w.shown()).status === "empty");
  assert.equal(w.meta().status, "empty");
  await w.dispose();
});

test("clearing twice in a row writes once", async () => {
  const w = await boot({ metadata: { t1: structuredClone(READY) } });
  const writes = w.world.metadataWrites;
  await w.rpc("followups_dismiss", { threadId: "t1" });
  await w.rpc("followups_dismiss", { threadId: "t1" });
  assert.equal(w.world.metadataWrites - writes, 1);
  await w.dispose();
});

test("a 'working' state left behind by a restart reads as empty once it is old", async () => {
  const w = await boot({ metadata: { t1: { status: "working", suggestions: [], updatedAt: Date.now() - 10 * 60_000 } } });
  assert.equal((await w.shown()).status, "empty");
  await w.dispose();
});

// ---- a reload with work in flight ----

test("a reload kills a message draft in flight too, and says nothing afterwards", async () => {
  const w = await boot({ metadata: { t1: structuredClone(READY) } });
  w.claude.answer({ draft: { output: { message: "late" }, gate: w.claude.gate("never") } });
  const outcome = w.rpc("followups_expand", { threadId: "t1", id: "a1" }).then((value) => ({ value }), (error) => ({ error }));
  await until(() => w.claude.calls("draft").length === 1);
  await w.host.harness.dispose();
  await until(() => !alive(w.claude.calls("draft")[0].pid));
  await outcome; // settles instead of hanging
  assert.deepEqual(w.warnings(), []);
  await w.claude.cleanup();
});

test("a call that hasn't started when the plugin reloads never starts", async () => {
  const w = await boot();
  w.claude.answer({ suggest: { output: { candidates: [] }, gate: w.claude.gate("held") } });
  for (const id of ["a", "b", "c", "d", "e"]) w.addThread(id);
  for (const id of ["a", "b", "c", "d", "e"]) await w.idle(id);
  await until(() => w.claude.calls("suggest").length === 4);
  await w.host.harness.dispose();
  w.claude.open("held");
  await sleep(400);
  assert.equal(w.claude.calls("suggest").length, 4, "the fifth, still queued, never ran");
  await w.claude.cleanup();
});

// ---- unreadable stored metadata ----

test("a thread switched off stays off when its stored follow-ups can't be read", async () => {
  const w = await boot({ metadata: { t1: { override: "off", suggestions: "not a list" } } });
  assert.equal((await w.shown()).enabled, false);
  await w.idle();
  await sleep(250);
  assert.equal(w.claude.calls().length, 0, "no call for a thread the user switched off");
  await w.dispose();
});

test("a thread switched on stays on when its stored follow-ups can't be read", async () => {
  const w = await boot({ metadata: { t1: { override: "on", status: 42 } } });
  assert.equal((await w.shown()).enabled, true);
  await w.dispose();
});

test("if the thread's choice can't be read, no call is made and the failure is logged", async () => {
  const w = await boot();
  w.world.metadataFails = true;
  await w.idle();
  await sleep(300);
  assert.equal(w.claude.calls().length, 0, "a billed call for a thread that may be off would be worse than none");
  assert.ok(w.warnings().some((m) => /t1/.test(m) && /metadata is down/.test(m)), JSON.stringify(w.logs()));
  await w.dispose();
});

// ---- an "answer" that is the user's own message ----

test("an idle thread whose last output is the user's own message gets no follow-ups", async () => {
  const w = await boot({ threads: { t1: { turns: [{ initiator: "user", source: "spawn", text: "Fix the flaky retry test" }] } } });
  await w.idle("t1", "Fix the flaky retry test"); // BB reports the user's message when no assistant reply exists
  await until(() => w.logs().some((m) => /no assistant answer/.test(m)));
  assert.equal(w.claude.calls().length, 0);
  assert.equal((await w.shown()).status, "empty");
  await w.dispose();
});

test("a real answer to that message is still drafted for", async () => {
  const w = await boot({ threads: { t1: { turns: [{ initiator: "user", source: "spawn", text: "Fix the flaky retry test" }] } } });
  await w.idle("t1", "I fixed it by awaiting the timer. Want me to run the suite?");
  await w.untilReady();
  assert.equal(w.claude.calls("suggest").length, 1);
  await w.dispose();
});

// ---- what agent sessions get ----

test("every thread's agent gets the followups skill, and no tools or instructions", async () => {
  const w = await boot();
  const resolved = await w.host.harness.resolveAgentConfiguration(makePluginAgentConfigurationContext());
  assert.deepEqual(resolved.skills, ["followups"]);
  assert.deepEqual(resolved.tools, []);
  assert.equal(resolved.instructions, null);
  await w.dispose();
});

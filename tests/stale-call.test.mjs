// A call drafting follow-ups for an answer the thread has moved on from is killed as soon as
// that is known, and the next run starts without waiting for it. Results that arrive for an
// outdated answer are dropped. The same goes for the call writing the message for a follow-up
// the user clicked. Run with `npm test`.
import assert from "node:assert/strict";
import test from "node:test";
import { alive, boot, DRAFT, sleep, suggested, until } from "./helpers.mjs";

const HELD = (gate) => ({ output: suggested("An outdated idea"), gate });

/** A world whose first suggestion call waits for `open("first")`; later ones answer at once. */
async function held(options = {}) {
  const w = await boot(options);
  w.claude.answer({
    suggest: [HELD(w.claude.gate("first")), { output: suggested("Add a test") }],
    draft: { output: { message: DRAFT }, gate: w.claude.gate("draft") },
  });
  return w;
}

const TRIGGERS = [
  ["the thread goes active", (w) => w.active()],
  ["a message is queued", (w) => w.event("message.queued", { entry: { threadId: "t1" } })],
  ["a message is dispatched", (w) => w.event("message.dispatched", { entry: { threadId: "t1" } })],
];

for (const [name, trigger] of TRIGGERS) {
  test(`when ${name}, the suggestion call is killed at once`, async () => {
    const w = await held();
    await w.idle("t1", "First answer.");
    await until(() => w.claude.calls("suggest").length === 1);
    const { pid } = w.claude.calls("suggest")[0];
    const before = Date.now();
    await trigger(w);
    await until(() => !alive(pid), 1500);
    assert.ok(Date.now() - before < 500, `killed ${Date.now() - before}ms after the trigger`);
    await until(() => w.logs().some((m) => /stopped the call for t1/.test(m)));
    assert.equal((await w.shown()).status, "empty");
    await w.dispose();
  });
}

test("the next run does not wait for the old call, and only the new answer is shown", async () => {
  const w = await held();
  await w.idle("t1", "Answer A.");
  await until(() => w.claude.calls("suggest").length === 1);
  await w.active();
  const started = Date.now();
  await w.idle("t1", "Answer B.");
  await until(() => w.claude.calls("suggest").length === 2, 2000);
  assert.ok(Date.now() - started < 1500, `the new call started ${Date.now() - started}ms later`);
  assert.ok(!alive(w.claude.calls("suggest")[0].pid), "the old call was killed");
  assert.match(w.claude.calls("suggest")[1].stdin, /Answer B\./);
  assert.doesNotMatch(w.claude.calls("suggest")[1].stdin, /Answer A\./);
  await w.untilReady();
  w.claude.open("first");
  await sleep(300);
  const labels = (await w.shown()).suggestions.map((s) => s.label);
  assert.equal(labels[0], "Add a test");
  assert.ok(!labels.includes("An outdated idea"), JSON.stringify(labels));
  await w.dispose();
});

test("a newer answer queued behind a running call takes over without waiting, with no clear in between", async () => {
  const w = await held();
  await w.idle("t1", "Answer A.");
  await until(() => w.claude.calls("suggest").length === 1);
  await w.idle("t1", "Answer B.");
  await until(() => w.claude.calls("suggest").length === 2, 2000);
  assert.ok(!alive(w.claude.calls("suggest")[0].pid));
  assert.match(w.claude.calls("suggest")[1].stdin, /Answer B\./);
  await w.untilReady();
  await w.dispose();
});

test("a call stopped for a newer run that then doesn't happen is not left saying it is working", async () => {
  const w = await held();
  await w.idle("t1", "Answer A.");
  await until(() => w.claude.calls("suggest").length === 1);
  assert.equal((await w.shown()).status, "working");
  w.world.threads.t1.status = "active"; // busy again, so the queued run has nothing to do
  await w.event("thread.idle", { thread: w.row("t1"), lastAssistantText: "Answer B." });
  await until(() => !alive(w.claude.calls("suggest")[0].pid), 1500);
  await sleep(300);
  assert.equal((await w.shown()).status, "empty");
  assert.equal(w.claude.calls("suggest").length, 1);
  await w.dispose();
});

for (const [name, trigger] of [
  ["turning the thread off", (w) => w.setEnabled(false)],
  ["dismissing the \"finding follow-ups\" skeleton", (w) => w.rpc("followups_dismiss", { threadId: "t1" })],
  ["the thread going away", (w) => w.event("thread.deleted", { thread: w.row("t1") })],
]) {
  test(`${name} kills the suggestion call`, async () => {
    const w = await held();
    await w.idle("t1", "Answer A.");
    await until(() => w.claude.calls("suggest").length === 1);
    await trigger(w);
    await until(() => !alive(w.claude.calls("suggest")[0].pid), 1500);
    assert.equal(w.claude.calls("suggest").length, 1, "nothing started in its place");
    await w.dispose();
  });
}

test("a call nobody has moved on from is left to finish", async () => {
  const w = await boot({ claude: { suggest: { output: suggested("Add a test"), delayMs: 250 } } });
  await w.idle();
  await w.untilReady();
  assert.ok(!w.logs().some((m) => /stopped the call/.test(m)), JSON.stringify(w.logs()));
  assert.equal((await w.shown()).suggestions[0].label, "Add a test");
  await w.dispose();
});

// ---- the call writing the message for a clicked follow-up ----

/** Get follow-ups showing for t1, and return the id of the first one. */
async function withFollowups(w) {
  w.claude.open("first");
  await w.idle();
  await w.untilReady();
  return (await w.shown()).suggestions[0].id;
}

/** Click a follow-up: start the draft and settle its outcome without leaving a rejection unhandled. */
function click(w, id) {
  return w.rpc("followups_expand", { threadId: "t1", id }).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
}

const DRAFT_TRIGGERS = [
  ...TRIGGERS,
  ["the banner is dismissed", (w) => w.rpc("followups_dismiss", { threadId: "t1" })],
  ["follow-ups are turned off for the thread", (w) => w.setEnabled(false)],
  ["the thread is deleted", (w) => w.event("thread.deleted", { thread: w.row("t1") })],
];

for (const [name, trigger] of DRAFT_TRIGGERS) {
  test(`when ${name}, the message draft's call is killed at once and the draft is refused`, async () => {
    const w = await held();
    const id = await withFollowups(w);
    const outcome = click(w, id);
    await until(() => w.claude.calls("draft").length === 1);
    const { pid } = w.claude.calls("draft")[0];
    await trigger(w);
    await until(() => !alive(pid), 1500);
    const { value, error } = await outcome;
    assert.equal(value, undefined, "no draft is handed over");
    assert.match(error.message, /no longer available/);
    assert.ok(w.logs().some((m) => /stopped the message draft for t1/.test(m)), JSON.stringify(w.logs()));
    assert.equal(w.claude.calls("draft").length, 1, "nothing was started in its place");
    await w.dispose();
  });
}

test("every message draft in flight for the thread is stopped, not just one", async () => {
  const w = await held();
  const id = await withFollowups(w);
  const first = click(w, id);
  const second = click(w, id);
  await until(() => w.claude.calls("draft").length === 2);
  await w.active();
  await until(() => w.claude.calls("draft").every((call) => !alive(call.pid)), 1500);
  assert.match((await first).error.message, /no longer available/);
  assert.match((await second).error.message, /no longer available/);
  await w.dispose();
});

test("a repeated idle event doesn't take the message being written away from the user", async () => {
  const w = await held();
  const id = await withFollowups(w);
  const outcome = click(w, id);
  await until(() => w.claude.calls("draft").length === 1);
  await w.idle(); // nothing was cleared: only a newer suggestion run is queued
  await sleep(300);
  assert.ok(alive(w.claude.calls("draft")[0].pid), "the message draft keeps going");
  w.claude.open("draft");
  const { value, error } = await outcome;
  assert.equal(error, undefined);
  assert.equal(value.text, DRAFT);
  await w.dispose();
});

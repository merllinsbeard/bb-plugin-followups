// Follow-ups can be switched on or off for one thread. A thread's own choice beats the
// default for threads that haven't made one. Run with `npm test`.
import assert from "node:assert/strict";
import test from "node:test";
import { boot, sleep, suggested, until } from "./helpers.mjs";

const calls = (w) => w.model.calls("suggest").length;

test("by default a thread has follow-ups on", async () => {
  const w = await boot();
  assert.equal((await w.shown()).enabled, true);
  await w.idle();
  await w.untilReady();
  await w.dispose();
});

test("turning a thread off clears what it was showing and says so", async () => {
  const w = await boot();
  await w.idle();
  await w.untilReady();
  assert.deepEqual(await w.setEnabled(false), { enabled: false });
  const got = await w.shown();
  assert.equal(got.enabled, false);
  assert.equal(got.status, "empty");
  assert.deepEqual(got.suggestions, []);
  assert.ok(w.host.harness.realtimeSignals.some((s) => s.payload?.threadId === "t1"), "the banner is told to refresh");
  await w.dispose();
});

test("an off thread gets no follow-ups when it finishes, and no call is made", async () => {
  const w = await boot();
  await w.setEnabled(false);
  await w.idle();
  await sleep(300);
  assert.equal(calls(w), 0);
  assert.equal((await w.shown()).status, "empty");
  await w.dispose();
});

test("one thread's choice doesn't touch another", async () => {
  const w = await boot({ threads: { t1: {}, t2: {} } });
  await w.setEnabled(false, "t1");
  assert.equal((await w.shown("t2")).enabled, true);
  await w.idle("t1");
  await w.idle("t2");
  await w.untilReady("t2");
  assert.equal(calls(w), 1, "only t2 was drafted");
  assert.equal((await w.shown("t1")).status, "empty");
  await w.dispose();
});

test("turning a finished thread on drafts from its latest answer right away", async () => {
  const w = await boot();
  await w.setEnabled(false);
  assert.deepEqual(await w.setEnabled(true), { enabled: true });
  await w.untilReady();
  assert.equal((await w.shown()).enabled, true);
  assert.match(w.model.calls("suggest")[0].stdin, /t1's answer\./);
  await w.dispose();
});

test("turning a running thread on waits for it to finish", async () => {
  const w = await boot({ threads: { t1: { status: "active" } } });
  await w.setEnabled(false);
  await w.setEnabled(true);
  await sleep(250);
  assert.equal(calls(w), 0, "nothing to draft from while it works");
  await w.idle();
  await w.untilReady();
  await w.dispose();
});

test("turning on a thread that already shows follow-ups doesn't draft again", async () => {
  const w = await boot();
  await w.idle();
  await w.untilReady();
  await w.setEnabled(true);
  await sleep(300);
  assert.equal(calls(w), 1);
  await w.dispose();
});

test("the choice survives the thread working again and a new answer", async () => {
  const w = await boot();
  await w.setEnabled(false);
  await w.active();
  assert.equal((await w.shown()).enabled, false);
  await w.idle();
  await sleep(250);
  assert.equal(calls(w), 0);
  assert.equal((await w.shown()).enabled, false);
  await w.dispose();
});

test("dismissing the banner doesn't turn follow-ups off for the thread", async () => {
  const w = await boot();
  await w.idle();
  await w.untilReady();
  await w.rpc("followups_dismiss", { threadId: "t1" });
  const got = await w.shown();
  assert.equal(got.status, "empty");
  assert.equal(got.enabled, true);
  await w.dispose();
});

test("an off thread isn't checked for child threads", async () => {
  const w = await boot({ threads: { t1: {}, kid: { status: "active", parent: "t1", visibility: "hidden" } } });
  await w.setEnabled(false);
  await w.idle();
  await sleep(250);
  assert.equal(w.world.listCalls.filter((args) => args.parentThreadId).length, 0);
  assert.ok(!w.logs().some((m) => /child thread/.test(m)));
  await w.dispose();
});

test("turning a thread on and off is logged", async () => {
  const w = await boot();
  await w.setEnabled(false);
  await w.setEnabled(true);
  assert.ok(w.logs().some((m) => /followups turned off for t1/.test(m)), JSON.stringify(w.logs()));
  assert.ok(w.logs().some((m) => /followups turned on for t1/.test(m)), JSON.stringify(w.logs()));
  await w.dispose();
});

test("`bb followups off` and `on` change one thread, and `show` says which it is", async () => {
  const w = await boot();
  const off = await w.cli("off", "t1");
  assert.equal(off.exitCode, 0);
  assert.match(off.stdout, /off for t1/);
  assert.match((await w.cli("show", "t1")).stdout, /off for t1/);
  assert.equal(JSON.parse((await w.cli("show", "t1", "--json")).stdout).enabled, false);
  const on = await w.cli("on", "t1");
  assert.equal(on.exitCode, 0);
  assert.match(on.stdout, /on for t1/);
  assert.equal((await w.shown()).enabled, true);
  await w.untilReady();
  await w.dispose();
});

test("`bb followups on` and `off` need exactly one thread id", async () => {
  const w = await boot();
  for (const argv of [["on"], ["off"], ["on", "a", "b"], ["off", "a", "b"]]) {
    const result = await w.cli(...argv);
    assert.equal(result.exitCode, 1, argv.join(" "));
    assert.match(result.stderr, /Usage/);
  }
  await w.dispose();
});

test("`bb followups regenerate` refuses a thread that is off and makes no call", async () => {
  const w = await boot();
  await w.setEnabled(false);
  const result = await w.cli("regenerate", "t1");
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /turned off for t1/);
  assert.match(result.stderr, /followups on t1/);
  assert.equal(calls(w), 0);
  await w.dispose();
});

test("`bb followups regenerate` while a call is running waits for its own run, and reports that one", async () => {
  const w = await boot();
  w.model.answer({
    suggest: [
      { output: suggested("Old"), gate: w.model.gate("first") },
      { output: suggested("Add a test") },
    ],
  });
  await w.idle();
  await until(() => calls(w) === 1);
  let done = false;
  const result = w.cli("regenerate", "t1").then((value) => { done = true; return value; });
  await until(() => calls(w) === 2);
  const { exitCode, stdout } = await result;
  assert.equal(done, true);
  assert.equal(exitCode, 0);
  assert.match(stdout, /3 suggestion\(s\), 3 with a reason \(ready\)/);
  assert.match(stdout, /^Took \d+ms/m);
  assert.match(stdout, /Add a test/);
  await w.dispose();
});

// bb records a thread's first message the same way whether the owner typed it in the app or an
// agent, cron or script ran `bb thread spawn`. Only the message.dispatch hook's origin tells them
// apart, so the plugin notes it there, without slowing or risking anyone's message.
// Run with `npm test`.
import assert from "node:assert/strict";
import test from "node:test";
import { makeMessageDispatchHookContext } from "@get-bb/plugin-sdk/testing";
import { boot, sleep, until } from "./helpers.mjs";

const calls = (w) => w.claude.calls("suggest").length;

/** bb dispatches the first message of thread `id`, which is still pending, from `origin`. */
async function started(w, id, origin) {
  const status = w.world.threads[id].status;
  w.world.threads[id].status = "pending";
  const decision = w.dispatch({ thread: w.row(id), origin, parentThreadId: w.world.threads[id].parent });
  w.world.threads[id].status = status;
  await until(() => w.meta(id).startOrigin === origin);
  return decision;
}

test("a root thread started from the CLI gets no follow-ups", async () => {
  const w = await boot();
  await started(w, "t1", "cli");
  await w.idle();
  await sleep(300);
  assert.equal(calls(w), 0);
  assert.equal((await w.shown()).enabled, false);
  await w.dispose();
});

test("a thread the owner started in the app gets them, a child thread too", async () => {
  const w = await boot({ threads: { boss: {}, kid: { parent: "boss" } } });
  await started(w, "kid", "app");
  await w.idle("kid");
  await w.untilReady("kid");
  await w.dispose();
});

test("an owner's later message turns a CLI-started thread's follow-ups on", async () => {
  const w = await boot();
  await started(w, "t1", "cli");
  await w.say("t1", "Now write the summary");
  await w.idle();
  await w.untilReady();
  await w.dispose();
});

test("the hook lets every message through at once, whatever it is handed", async () => {
  const w = await boot();
  const hook = w.host.harness.registrations.hooks["message.dispatch"];
  const writes = w.world.metadataWrites;
  for (const context of [
    undefined,
    null,
    42,
    {},
    { attempt: "start-turn" },
    { attempt: "start-turn", thread: { id: "t1", status: "pending" }, origin: "mixed" },
    makeMessageDispatchHookContext({ attempt: "join-turn", origin: "app" }),
    makeMessageDispatchHookContext({ origin: null }),
  ]) {
    const decision = hook(context);
    assert.ok(!(decision instanceof Promise), "it never makes bb wait");
    assert.deepEqual(decision, { action: "proceed" });
  }
  await sleep(50);
  assert.equal(w.world.metadataWrites, writes, "nothing was recorded for them");
  await w.dispose();
});

test("only a pending thread's first message is recorded; later messages don't change it", async () => {
  const w = await boot();
  await started(w, "t1", "cli");
  assert.deepEqual(w.dispatch({ thread: w.row("t1"), origin: "app" }), { action: "proceed" }); // t1 is idle: a follow-up
  await sleep(50);
  assert.equal(w.meta().startOrigin, "cli");
  await w.dispose();
});

test("a failed write never fails the message, and is logged", async () => {
  const w = await boot();
  w.world.metadataFails = true;
  w.world.threads.t1.status = "pending";
  assert.deepEqual(w.dispatch({ thread: w.row("t1"), origin: "cli" }), { action: "proceed" });
  await until(() => w.warnings().some((m) => /could not record how t1 was started/.test(m)));
  await w.dispose();
});

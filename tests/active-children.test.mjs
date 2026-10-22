// A thread whose child threads are still running isn't finished, even though its own agent is
// idle: it is waiting on them. Follow-ups wait too, and arrive once the children are done.
// Run with `npm test`.
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { boot, sleep, suggested, until } from "./helpers.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A captain thread with hidden children: each kid is [id, status, parent = "captain"]. */
const captainWith = (...kids) => ({
  captain: {},
  ...Object.fromEntries(kids.map(([id, status, parent = "captain"]) => [id, { parent, status, visibility: "hidden" }])),
});

async function crew(threads) {
  const w = await boot({ threads });
  return Object.assign(w, {
    calls: () => w.claude.calls("suggest").length,
    // a child stopped working: change its status, tell the plugin, and let the settle timer fire
    async childStops(id, status = "idle") {
      w.world.threads[id].status = status;
      mock.timers.enable({ apis: ["setTimeout"] });
      try {
        await w.event("thread.idle", { thread: w.row(id), lastAssistantText: "done" });
        await flush();
        mock.timers.tick(5000);
      } finally {
        mock.timers.reset();
      }
    },
  });
}

test("an idle thread with a running child gets no follow-ups yet", async () => {
  const w = await crew(captainWith(["kid", "active"]));
  await w.idle("captain");
  await sleep(300);
  assert.equal(w.calls(), 0, "no call may be made");
  assert.equal((await w.shown("captain")).status, "empty");
  assert.ok(w.logs().some((m) => /captain is idle but 1 child thread\(s\) are still running/.test(m)), JSON.stringify(w.logs()));
  await w.dispose();
});

for (const status of ["active", "starting", "pending", "stopping"]) {
  test(`a child that is ${status} counts as still working`, async () => {
    const w = await crew(captainWith(["kid", status]));
    await w.idle("captain");
    await sleep(250);
    assert.equal(w.calls(), 0);
    await w.dispose();
  });
}

for (const status of ["idle", "error"]) {
  test(`a child that is ${status} does not hold the parent back`, async () => {
    const w = await crew(captainWith(["kid", status]));
    await w.idle("captain");
    await w.untilReady("captain");
    assert.equal(w.calls(), 1);
    await w.dispose();
  });
}

test("an idle child with a running grandchild still counts, three levels down too", async () => {
  for (const threads of [
    captainWith(["kid", "idle"], ["grandkid", "active", "kid"]),
    captainWith(["a", "idle"], ["b", "idle", "a"], ["c", "active", "b"]),
  ]) {
    const w = await crew(threads);
    await w.idle("captain");
    await sleep(250);
    assert.equal(w.calls(), 0, JSON.stringify(Object.keys(threads)));
    await w.dispose();
  }
});

test("hidden children are looked at, and archived ones (left out of the default list) are not needed", async () => {
  const w = await crew(captainWith(["kid", "active"]));
  await w.idle("captain");
  await sleep(200);
  const childLookups = w.world.listCalls.filter((args) => args.parentThreadId === "captain");
  assert.ok(childLookups.length >= 1);
  assert.ok(childLookups.every((args) => args.includeHidden === true), "hidden children must be included");
  assert.ok(childLookups.every((args) => args.archived !== true), "archived children are finished work");
  await w.dispose();
});

test("a parent/child cycle can't hang the check", async () => {
  const w = await crew({ a: { parent: "b", turns: [{ initiator: "user", source: "tell", text: "go" }] }, b: { parent: "a", visibility: "hidden" } });
  await w.idle("a");
  await w.untilReady("a");
  await w.dispose();
});

test("if the children can't be looked up, follow-ups still arrive and the failure is logged", async () => {
  const w = await crew(captainWith(["kid", "active"]));
  w.world.listFails = true;
  await w.idle("captain");
  await w.untilReady("captain");
  assert.ok(w.warnings().some((m) => /child threads/.test(m) && /list is down/.test(m)), JSON.stringify(w.logs()));
  await w.dispose();
});

test("once the last child finishes and the parent stays idle, follow-ups are drafted", async () => {
  const w = await crew(captainWith(["kid", "active"]));
  await w.idle("captain");
  await sleep(200);
  assert.equal(w.calls(), 0);
  await w.childStops("kid");
  await w.untilReady("captain");
  assert.ok(w.logs().some((m) => /children of captain finished/.test(m)));
  await w.dispose();
});

test("with two children, nothing is drafted until the second one finishes", async () => {
  const w = await crew(captainWith(["one", "active"], ["two", "active"]));
  await w.idle("captain");
  await w.childStops("one");
  await sleep(300);
  assert.equal(w.calls(), 0, "one child is still running");
  await w.childStops("two");
  await w.untilReady("captain");
  await w.dispose();
});

test("a grandchild finishing releases the waiting grandparent", async () => {
  const w = await crew(captainWith(["kid", "idle"], ["grandkid", "active", "kid"]));
  await w.idle("captain");
  await sleep(200);
  assert.equal(w.calls(), 0);
  await w.childStops("grandkid");
  await w.untilReady("captain");
  await w.dispose();
});

test("if the parent wakes up first (a child's report starts a turn), nothing is drafted from the old answer", async () => {
  const w = await crew(captainWith(["kid", "active"]));
  await w.idle("captain");
  await sleep(150);
  await w.active("captain");
  await w.childStops("kid");
  await sleep(400);
  assert.equal(w.calls(), 0);
  // ...and when its own turn ends, the normal idle path drafts as usual
  await w.idle("captain");
  await w.untilReady("captain");
  await w.dispose();
});

test("a thread that was never waiting is left alone when a child finishes", async () => {
  const w = await crew(captainWith(["kid", "idle"]));
  await w.idle("captain");
  await w.untilReady("captain");
  const lookedUp = () => ({
    parent: w.world.getCalls.filter((id) => id === "captain").length,
    children: w.world.listCalls.filter((args) => args.parentThreadId).length,
  });
  const before = lookedUp();
  await w.childStops("kid");
  await sleep(300);
  assert.equal(w.calls(), 1, "no second call");
  assert.deepEqual(lookedUp(), before, "nothing about the parent or its children is looked up when nothing is waiting");
  await w.dispose();
});

test("a child that starts working while the answer is being drafted keeps the follow-ups back", async () => {
  const w = await crew(captainWith(["kid", "idle"]));
  w.claude.answer({ suggest: [{ output: suggested("Add a test"), gate: w.claude.gate("first") }, { output: suggested("Add a test") }] });
  await w.idle("captain");
  await until(() => w.calls() === 1);
  w.world.threads.kid.status = "active";
  w.claude.open("first");
  await until(() => w.logs().some((m) => /holding them back/.test(m)));
  const got = await w.shown("captain");
  assert.equal(got.status, "empty", "the drafted suggestions must not be shown while a child runs");
  assert.deepEqual(got.suggestions, []);
  // and they come once that child finishes
  await w.childStops("kid");
  await until(() => w.calls() === 2);
  await w.untilReady("captain");
  await w.dispose();
});

test("`bb followups regenerate` refuses a thread that is waiting on child threads", async () => {
  const w = await crew(captainWith(["kid", "active"]));
  const result = await w.cli("regenerate", "captain");
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /child thread/);
  assert.equal(w.calls(), 0);
  await w.dispose();
});

// Only a few suggestion calls run at once: a burst of threads finishing together (an agent team,
// say) queues instead of starting a model process, and its tokens, for every one of them at the
// same time. A call waiting its turn shows nothing; one that moves on while waiting never starts.
// The message draft for a clicked follow-up is never held up. Run with `npm test`.
import assert from "node:assert/strict";
import test from "node:test";
import { alive, boot, sleep, suggested, until } from "./helpers.mjs";

const MAX = 4; // MAX_CONCURRENT_DRAFTS in server.ts
const IDS = ["t1", "t2", "t3", "t4", "t5", "t6"];
const ANSWER = suggested("Add a test");

/** Threads t1..t6 (and t8), where the nth suggestion call to start waits for `open("n")`. */
async function full({ failFirst = 0 } = {}) {
  const w = await boot({ threads: Object.fromEntries([...IDS, "t8"].map((id) => [id, {}])) });
  w.model.answer({
    suggest: Array.from({ length: 10 }, (_, n) =>
      n < failFirst ? { fail: "exit" } : { output: ANSWER, gate: w.model.gate(String(n + 1)) },
    ),
    draft: { output: { message: "Please add a test." } },
  });
  const forWhom = (n) => /(t\d+)'s answer\./.exec(w.model.calls("suggest")[n - 1].stdin)?.[1];
  return Object.assign(w, { forWhom, started: () => w.model.calls("suggest").length });
}
/** Threads finish one after another: each has started its call or joined the queue before the next finishes. */
const burst = async (w, ids) => {
  for (const id of ids) {
    const before = w.started();
    await w.idle(id);
    await until(() => w.started() > before || w.logs().some((m) => m.includes(`${id} is waiting for a free slot`)));
  }
};

test("no more than four calls run at once, and the rest show nothing while they wait", async () => {
  const w = await full();
  await burst(w, IDS);
  await until(() => w.started() === MAX);
  await sleep(400);
  assert.equal(w.started(), MAX, "the fifth and sixth are queued");
  assert.equal((await w.shown("t1")).status, "working");
  assert.equal((await w.shown("t5")).status, "empty", "no skeleton for a call that hasn't started");
  assert.equal((await w.shown("t6")).status, "empty");
  assert.ok(w.logs().some((m) => /t5 is waiting for a free slot/.test(m)), JSON.stringify(w.logs()));
  await w.dispose();
});

test("a finished call hands its place to the next in line, in the order they arrived", async () => {
  const w = await full();
  await burst(w, IDS);
  await until(() => w.started() === MAX);
  w.model.open("1");
  await until(() => w.started() === MAX + 1);
  assert.equal(w.forWhom(5), "t5");
  w.model.open("2");
  await until(() => w.started() === MAX + 2);
  assert.equal(w.forWhom(6), "t6");
  await until(async () => (await w.shown(w.forWhom(1))).status === "ready");
  await w.dispose();
});

test("a call whose thread moves on while it waits never starts, and its place goes to the next in line", async () => {
  const w = await full();
  await burst(w, IDS);
  await until(() => w.started() === MAX);
  await w.active("t5"); // the user carried on in t5
  w.model.open("1");
  await until(() => w.started() === MAX + 1);
  assert.equal(w.forWhom(5), "t6", "t6's call took the place, not t5's");
  await sleep(300);
  assert.equal(w.started(), MAX + 1, "t5's call never started");
  await w.dispose();
});

test("a call that fails gives its place back and leaves its banner empty", async () => {
  const w = await full({ failFirst: MAX });
  await burst(w, IDS);
  await until(() => w.started() === MAX + 2);
  const failed = [1, 2, 3, 4].map((n) => w.forWhom(n));
  assert.deepEqual([w.forWhom(5), w.forWhom(6)].sort(), ["t5", "t6"]);
  for (const id of failed) await until(async () => (await w.shown(id)).status === "empty");
  await w.dispose();
});

test("a call stopped because its thread moved on gives its place back", async () => {
  const w = await full();
  await burst(w, ["t1", "t2", "t3", "t4", "t5"]);
  await until(() => w.started() === MAX);
  const t1 = [1, 2, 3, 4].find((n) => w.forWhom(n) === "t1");
  await w.active("t1");
  await until(() => w.started() === MAX + 1, 2000);
  assert.equal(w.forWhom(5), "t5");
  await until(() => !alive(w.model.calls("suggest")[t1 - 1].pid));
  await w.dispose();
});

test("the message draft for a clicked follow-up isn't held up by a full house", async () => {
  const w = await full();
  w.world.metadata.followups.t8 = { status: "ready", suggestions: [{ id: "a1", label: "Add a test" }], updatedAt: Date.now() };
  await burst(w, ["t1", "t2", "t3", "t4", "t5"]);
  await until(() => w.started() === MAX);
  const clicked = await w.rpc("followups_expand", { threadId: "t8", id: "a1" });
  assert.equal(clicked.text, "Please add a test.");
  await w.dispose();
});

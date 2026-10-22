// What the owner does with each banner is remembered: a suggestion he picked and sent as
// drafted, one he edited, his own message instead, or a banner nobody answered. His recent
// choices go into the next prompts, and `bb followups stats` counts them. Run with `npm test`.
import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { openLearning, TEXTS_PER_SCOPE } from "../lib/learning.ts";
import plugin from "../server.ts";
import { boot, DRAFT, until } from "./helpers.mjs";

const stats = async (w, ...args) => JSON.parse((await w.cli("stats", ...args, "--json")).stdout);

/** t1 finishes, shows its banner, and the owner clicks the first suggestion (kind check). */
async function picked(w) {
  await w.idle();
  await w.untilReady();
  const [first] = (await w.shown()).suggestions;
  await w.rpc("followups_expand", { threadId: "t1", id: first.id });
  return first;
}

/** The owner sends `text` and the plugin has read it. */
async function sends(w, text) {
  await w.say("t1", text);
  await until(async () => (await stats(w)).answered === 1);
}

test("a picked suggestion sent as drafted counts as sent as is", async () => {
  const w = await boot();
  await picked(w);
  await sends(w, DRAFT);
  const got = await stats(w);
  assert.equal(got.batches, 1);
  assert.equal(got.sentAsIs, 1);
  assert.equal(got.picked, 1);
  assert.equal(got.acceptance, 1);
  assert.deepEqual(got.byKind.check, { shown: 1, picked: 1 });
  assert.deepEqual(got.byKind.close, { shown: 1, picked: 0 });
  await w.dispose();
});

test("a draft he edited before sending counts as edited", async () => {
  const w = await boot();
  await picked(w);
  await sends(w, "Please add a test for the empty queue case and the full one.");
  assert.equal((await stats(w)).sentEdited, 1);
  await w.dispose();
});

test("a draft he replaced with something else counts as his own message, not a pick", async () => {
  const w = await boot();
  await picked(w);
  await sends(w, "Stop. Revert the whole branch.");
  const got = await stats(w);
  assert.equal(got.ownMessage, 1);
  assert.equal(got.picked, 0);
  assert.equal(got.acceptance, 0);
  await w.dispose();
});

test("a message without a click counts as his own", async () => {
  const w = await boot();
  await w.idle();
  await w.untilReady();
  await sends(w, "Ship it");
  assert.equal((await stats(w)).ownMessage, 1);
  await w.dispose();
});

test("a banner replaced by the next one with nothing sent is unanswered", async () => {
  const w = await boot();
  await w.idle("t1", "First answer.");
  await w.untilReady();
  await w.idle("t1", "Second answer.");
  await until(async () => (await stats(w)).batches === 2);
  const got = await stats(w);
  assert.equal(got.answered, 0);
  assert.equal(got.acceptance, null);
  await w.dispose();
});

test("dismissing the banner is counted, and `bb followups draft` is not a pick", async () => {
  const w = await boot();
  await w.idle();
  await w.untilReady();
  const [first] = (await w.shown()).suggestions;
  await w.cli("draft", "t1", first.id);
  await w.rpc("followups_dismiss", { threadId: "t1" });
  await sends(w, DRAFT);
  const got = await stats(w);
  assert.equal(got.dismissed, 1);
  assert.equal(got.ownMessage, 1, "the diagnostic draft didn't count as his click");
  await w.dispose();
});

test("his recent choices go into the next prompt", async () => {
  const w = await boot();
  await picked(w);
  await sends(w, DRAFT);
  await w.idle("t1", "Added the test. Want me to commit?");
  await until(() => w.claude.calls("suggest").length === 2);
  const { stdin } = w.claude.calls("suggest")[1];
  assert.match(stdin, /<example outcome="sent-as-is">\nshown: 1\) \[check\] Add a test for the empty queue; 2\) \[close\] Commit the fix; 3\) \[continue\] Retry path next\npicked: 1\nsent: Please add a test for the empty queue case\.\n<\/example>/);
  await w.dispose();
});

test("`stats` narrows to a project and a number of days, and refuses anything else", async () => {
  const w = await boot();
  await picked(w);
  await sends(w, DRAFT);
  assert.equal((await stats(w, "--project", "p", "--days", "1")).batches, 1);
  assert.equal((await stats(w, "--project", "elsewhere")).batches, 0);
  assert.match((await w.cli("stats")).stdout, /Answered 1: 1 sent as drafted, 0 edited, 0 own message\(s\)\. Acceptance 100%/);
  for (const argv of [["--days"], ["--days", "0"], ["--days", "x"], ["--colour", "red"]]) {
    assert.equal((await w.cli("stats", ...argv)).exitCode, 1, argv.join(" "));
  }
  await w.dispose();
});

test("what was learned survives a reload", async () => {
  const w = await boot();
  await picked(w);
  await sends(w, DRAFT);
  const next = await w.host.harness.reload(plugin);
  const result = await next.harness.runCli(["stats", "--json"]);
  assert.equal(JSON.parse(result.stdout).sentAsIs, 1);
  await next.harness.dispose();
  await w.claude.cleanup();
});

// ---- storage stays bounded ----

function learningAt(clock) {
  const db = new Database(":memory:");
  let n = 0;
  const migrate = (handle, statements) => statements.forEach((statement) => handle.exec(statement));
  return { db, learning: openLearning(db, migrate, () => `b${++n}`, () => clock.now) };
}

test("texts are kept only for the newest batches of each thread and project; counts stay", () => {
  const clock = { now: 1_000_000 };
  const { db, learning } = learningAt(clock);
  for (let i = 0; i < TEXTS_PER_SCOPE + 5; i++) {
    clock.now += 1_000;
    learning.shown("a", "p", [{ id: `s${i}`, label: `idea ${i}`, kind: "continue" }]);
    learning.ownerSent("a", `own words ${i}`, clock.now + 1);
  }
  const withText = db.prepare("SELECT COUNT(*) AS n FROM batches WHERE shown_json IS NOT NULL").get().n;
  assert.equal(withText, TEXTS_PER_SCOPE);
  assert.equal(learning.stats({ days: 1 }).ownMessage, TEXTS_PER_SCOPE + 5);
  assert.equal(learning.examples("a", "p").length, 5);
  assert.equal(learning.examples("a", "p")[0].sent, `own words ${TEXTS_PER_SCOPE + 4}`);
});

test("batches older than 90 days are deleted", () => {
  const clock = { now: 1_000_000 };
  const { learning } = learningAt(clock);
  learning.shown("a", "p", [{ id: "s1", label: "old idea", kind: "check" }]);
  clock.now += 91 * 24 * 60 * 60 * 1000;
  learning.shown("b", "p", [{ id: "s2", label: "new idea", kind: "check" }]);
  assert.equal(learning.stats({ days: 365 }).batches, 1);
});

test("a message older than the banner doesn't answer it", () => {
  const clock = { now: 1_000_000 };
  const { learning } = learningAt(clock);
  learning.shown("a", "p", [{ id: "s1", label: "idea", kind: "check" }]);
  learning.ownerSent("a", "an old message read late", clock.now - 5_000);
  assert.equal(learning.stats({ days: 1 }).answered, 0);
});

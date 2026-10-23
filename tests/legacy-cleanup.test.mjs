// Earlier releases drafted follow-ups in hidden worker threads. `bb followups cleanup` deletes
// the ones left behind, archiving each first, and never deletes the last live thread of an
// environment. Nothing in this release creates such threads. Run with `npm test`.
import assert from "node:assert/strict";
import test from "node:test";
import { boot } from "./helpers.mjs";

const worker = (spec = {}) => ({
  visibility: "hidden",
  originPluginId: "followups",
  title: "Followups suggestions",
  turns: [],
  ...spec,
});

async function withLeftovers(t, workers) {
  const w = await boot({ threads: { t1: {}, ...workers } });
  t.after(() => w.dispose());
  return Object.assign(w, { cleanup: async (...args) => JSON.parse((await w.cli("cleanup", ...args, "--json")).stdout) });
}

test("cleanup archives each leftover worker, then deletes it", async (t) => {
  const w = await withLeftovers(t, { old: worker(), older: worker({ title: "Followups draft", archivedAt: 1 }) });
  const report = await w.cleanup();
  assert.deepEqual(report.deleted.sort(), ["old", "older"]);
  assert.deepEqual(w.world.archived, ["old"], "the already archived one isn't archived again");
  assert.deepEqual(w.world.deleted.sort(), ["old", "older"]);
});

test("cleanup leaves alone what isn't a hidden follow-up worker, or is still running", async (t) => {
  const w = await withLeftovers(t, {
    visible: worker({ visibility: "visible" }),
    renamed: worker({ title: "Something else" }),
    running: worker({ status: "active" }),
  });
  const report = await w.cleanup();
  assert.deepEqual(report.deleted, []);
  assert.deepEqual(
    Object.fromEntries(report.skipped.map((s) => [s.id, s.reason])),
    { visible: "not a hidden follow-up worker", renamed: "not a hidden follow-up worker", running: "still active" },
  );
  assert.deepEqual(w.world.deleted, []);
});

test("cleanup dry-run lists what it would delete and touches nothing", async (t) => {
  const w = await withLeftovers(t, { old: worker() });
  assert.deepEqual((await w.cleanup("--dry-run")).deleted, ["old"]);
  assert.deepEqual(w.world.archived, []);
  assert.deepEqual(w.world.deleted, []);
});

test("cleanup never deletes a worker whose environment has no other live thread", async (t) => {
  const w = await withLeftovers(t, { old: worker({ environmentId: "lonely" }) });
  const report = await w.cleanup();
  assert.deepEqual(report.deleted, []);
  assert.equal(report.skipped[0].reason, "its environment has no other live thread");
  assert.deepEqual(w.world.archived, []);
});

test("a finished thread never spawns a worker thread any more", async (t) => {
  const w = await withLeftovers(t, {});
  await w.idle();
  await w.untilReady();
  assert.equal(w.world.spawned, 0);
  assert.equal((await w.cleanup()).deleted.length, 0);
});

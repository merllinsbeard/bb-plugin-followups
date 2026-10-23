// Both model routes drive the public plugin flow without worker threads.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { alive, boot, DRAFT, flag, sleep, suggested, until } from "./helpers.mjs";

test("a finished thread gets its suggestions from one lean claude call on the configured model", async () => {
  const w = await boot({ settings: { model: "claude-test-1", effort: "high" } });
  await w.idle();
  await w.untilReady();
  const [call, ...more] = w.model.calls("suggest");
  assert.equal(more.length, 0);
  assert.equal(flag(call, "--model"), "claude-test-1");
  assert.equal(flag(call, "--effort"), "high");
  assert.equal(flag(call, "--tools"), "");
  assert.equal(flag(call, "--setting-sources"), "");
  for (const option of ["-p", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"]) {
    assert.ok(call.argv.includes(option), option);
  }
  assert.equal(flag(call, "--output-format"), "json");
  assert.ok(!call.argv.includes("--restricted"), "suggestions never get the card's tools");
  assert.equal(w.world.spawned, 0, "no worker thread");
  const shown = await w.shown();
  assert.deepEqual(shown.suggestions.map((s) => s.label), ["Add a test for the empty queue", "Commit the fix", "Retry path next"]);
  assert.equal(shown.stats.model, "claude-code/claude-test-1@high");
  assert.equal(shown.stats.totalTokens, 900 + 100 + 2000 + 300);
  assert.equal(shown.stats.cachedInputTokens, 2000);
  await w.dispose();
});

test("by default every call runs Codex Luna at max effort", async () => {
  const w = await boot();
  await w.idle();
  await w.untilReady();
  const [call] = w.model.calls("suggest");
  assert.equal(call.provider, "codex");
  assert.equal(flag(call, "-m"), "gpt-6-luna");
  assert.ok(call.argv.includes("model_reasoning_effort=max"));
  assert.equal((await w.shown()).stats.model, "codex/gpt-6-luna@max");
  await w.dispose();
});

test("the conversation goes on stdin, and the call runs in a private directory that is removed afterwards", async () => {
  const w = await boot({ threads: { t1: { answer: "Fixed the null check in auth.ts. Want me to add a regression test?" } } });
  await w.idle();
  await w.untilReady();
  const [call] = w.model.calls("suggest");
  assert.match(call.stdin, /Fixed the null check in auth\.ts/);
  assert.match(call.stdin, /t1: please do the task\./);
  assert.ok(!call.argv.some((arg) => arg.includes("Fixed the null check")), "the answer is not in argv");
  assert.match(call.cwd, /followups-/);
  await until(() => !existsSync(call.cwd));
  await w.dispose();
});

for (const [fail, reason] of [
  ["exit", /exited 1/],
  ["is_error", /model error on purpose/],
  ["garbage", /no valid final JSON file/],
]) {
  test(`a call that fails (${fail}) leaves the banner empty and logs why`, async () => {
    const w = await boot({ answers: { suggest: { fail } } });
    await w.idle();
    await until(() => w.model.calls("suggest").length === 1);
    await until(() => w.warnings().some((m) => /generate failed for t1/.test(m)));
    assert.match(w.warnings().find((m) => /generate failed for t1/.test(m)), reason);
    assert.equal((await w.shown()).status, "empty");
    await w.dispose();
  });
}

test("an answer that doesn't match the schema leaves the banner empty", async () => {
  const w = await boot({ answers: { suggest: { output: { candidates: [{ label: "x".repeat(90), why: "too long" }] } } } });
  await w.idle();
  await until(() => w.warnings().some((m) => /does not match the schema/.test(m)));
  assert.equal((await w.shown()).status, "empty");
  await w.dispose();
});

test("without the codex CLI on PATH, the banner stays empty and the log says so", async () => {
  const w = await boot();
  const path = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    await w.idle();
    await until(() => w.warnings().some((m) => /codex CLI is not on PATH/.test(m)));
    assert.equal((await w.shown()).status, "empty");
  } finally {
    process.env.PATH = path;
  }
  await w.dispose();
});

test("clicking a suggestion drafts the message through the same lean call", async () => {
  const w = await boot();
  await w.idle();
  await w.untilReady();
  const picked = (await w.shown()).suggestions[0];
  const result = await w.rpc("followups_expand", { threadId: "t1", id: picked.id });
  assert.equal(result.drafted, true);
  assert.equal(result.text, DRAFT);
  assert.equal(result.stats.model, "codex/gpt-6-luna@max");
  const [call] = w.model.calls("draft");
  assert.ok(call.argv.includes("shell_tool"));
  assert.match(call.stdin, /<picked kind="check">Add a test for the empty queue<\/picked>/);
  assert.match(call.stdin, /<why>The answer says the empty queue is untested<\/why>/);
  assert.equal(w.world.spawned, 0);
  await w.dispose();
});

test("a draft wrapped in quotes or a fence is handed over clean", async () => {
  const w = await boot({ answers: { draft: { output: { message: "```\n\"Please add the test.\"\n```" } } } });
  await w.idle();
  await w.untilReady();
  const picked = (await w.shown()).suggestions[0];
  assert.equal((await w.rpc("followups_expand", { threadId: "t1", id: picked.id })).text, "Please add the test.");
  await w.dispose();
});

test("a draft that fails falls back to the short label, and says it wasn't drafted", async () => {
  const w = await boot({ answers: { draft: { fail: "is_error" } } });
  await w.idle();
  await w.untilReady();
  const picked = (await w.shown()).suggestions[0];
  const result = await w.rpc("followups_expand", { threadId: "t1", id: picked.id });
  assert.deepEqual(result, { text: picked.label, drafted: false, stats: null });
  await w.dispose();
});

test("`bb followups model` shows the model and effort, and `model-clear` resets both", async () => {
  const w = await boot({ settings: { model: "claude-test-1", effort: "low" } });
  assert.deepEqual(JSON.parse((await w.cli("model", "--json")).stdout), { model: "claude-test-1", effort: "low", provider: "claude" });
  const cleared = await w.cli("model-clear");
  assert.equal(cleared.exitCode, 0);
  assert.match(cleared.stdout, /gpt-6-luna at max effort/);
  await w.idle();
  await w.untilReady();
  assert.equal(flag(w.model.calls("suggest")[0], "-m"), "gpt-6-luna");
  await w.dispose();
});

test("changing the model setting applies to the next call", async () => {
  const w = await boot();
  await w.host.harness.setSettings({ model: "claude-test-2", effort: "medium" });
  await w.idle();
  await w.untilReady();
  const [call] = w.model.calls("suggest");
  assert.equal(flag(call, "--model"), "claude-test-2");
  assert.equal(flag(call, "--effort"), "medium");
  await w.dispose();
});

test("a reload kills the calls in flight and writes nothing afterwards", async () => {
  const w = await boot();
  w.model.answer({ suggest: { output: suggested(), gate: w.model.gate("late") } });
  await w.idle();
  await until(() => w.model.calls("suggest").length === 1);
  const { pid } = w.model.calls("suggest")[0];
  const writes = w.world.metadataWrites;
  await w.host.harness.dispose();
  await until(() => !alive(pid));
  w.model.open("late");
  await sleep(200);
  assert.equal(w.world.metadataWrites, writes);
  await w.model.cleanup();
});

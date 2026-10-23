// When the owner writes in a thread, a background run builds a short card about it (task,
// project, related goals, earlier decisions) that suggestions and other plugins read. Runs are
// few, confined and logged; suggestions never wait for one. Run with `npm test`.
//
// HOME points at a fixture tree with a fake `otask` and morning briefs (all text made up here).
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import plugin from "../server.ts";
import { boot, CARD_DRAFT, flag, sleep, suggested, until } from "./helpers.mjs";

const HOUR = 60 * 60_000;
const bangkokDay = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date(ms));
const TODAY = () => bangkokDay(Date.now());

const MATRIX = {
  areas: [
    { key: "inbox", cards: [{ text: "- [ ] INBOX-RAW", done: false }] },
    { key: "q3", cards: [{ text: "- [ ] Q3-ERRAND", done: false }] },
    { key: "q1", cards: [{ text: "- [ ] Q1-OPEN ship the parser", done: false }, { text: "- [x] Q1-DONE", done: true }] },
    { key: "q4", cards: [{ text: "- [ ] Q4-SOMEDAY", done: false }] },
    { key: "q2", cards: [{ text: "- [ ] Q2-OPEN write the docs", done: false }] },
  ],
};

let home;
let realHome;

/** A fixture HOME: `otask matrix` prints `matrix` (omitted: no otask at all); `briefs` maps a day to its Фокус lines. */
function ownerHome({ matrix = MATRIX, briefs = { [TODAY()]: ["1. FOCUS-ONE", "2. FOCUS-TWO"] } } = {}) {
  if (matrix) {
    const scripts = join(home, ".agents/skills/tasks-hub/scripts");
    mkdirSync(scripts, { recursive: true });
    writeFileSync(join(scripts, "otask"), `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(matrix))});\n`);
    chmodSync(join(scripts, "otask"), 0o755);
  }
  const briefDir = join(home, ".hermes/cron/output/578fe665e153");
  mkdirSync(briefDir, { recursive: true });
  for (const [day, focus] of Object.entries(briefs)) {
    writeFileSync(join(briefDir, `${day}_08-00-00.md`), `# Cron Job\n\n## Prompt\n\nФокус:\n1. NOT-THIS\n\n## Response\n\nУтро.\n\nФокус:\n${focus.join("\n")}\n\nДеньги: MONEY-STEP.\n`);
  }
}

beforeEach(() => {
  realHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "followups-home-"));
  process.env.HOME = home;
});
afterEach(() => {
  process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});

const cardsOn = (options = {}) => boot({ ...options, settings: { card: true, ...options.settings } });
const cardCalls = (w) => w.claude.calls("card");
const card = (w, id = "t1") => w.meta(id).card;
/** A card stored for t1 as an earlier run left it. */
const stored = (overrides = {}) => ({
  v: 1,
  threadId: "t1",
  projectId: "p",
  builtAt: Date.now() - 10 * 60_000,
  day: TODAY(),
  role: "root",
  ...CARD_DRAFT,
  ...overrides,
});

test("the owner's first message today builds one card with the v1 shape", async () => {
  ownerHome();
  const w = await cardsOn();
  await w.say("t1", "Build the parser");
  await until(() => card(w));
  assert.equal(cardCalls(w).length, 1);
  const got = JSON.parse((await w.cli("card", "t1", "--json")).stdout).card;
  assert.deepEqual(Object.keys(got).sort(), ["builtAt", "day", "decisions", "focusFit", "gaps", "goals", "project", "projectId", "role", "siblings", "task", "threadId", "v"]);
  assert.equal(got.v, 1);
  assert.equal(got.day, TODAY());
  assert.equal(got.role, "root");
  assert.equal(got.task, CARD_DRAFT.task);
  assert.deepEqual(got.gaps, ["project files: not on this machine"]);
  assert.match((await w.cli("card", "t1")).stdout, /^Карточка треда \(собрана \d{4}-\d\d-\d\d \d\d:\d\d, \d+ мин назад\)\nРоль: самостоятельный тред\nПроект: Плагин подсказок для bb\nЗадача: /);
  await w.dispose();
});

test("the run may only read the project and run `ov find`, with each call capped", async () => {
  ownerHome();
  const project = join(home, "project");
  mkdirSync(project);
  const w = await cardsOn({ environments: { e: project } });
  await w.say("t1", "Build the parser");
  await until(() => card(w));
  const [call] = cardCalls(w);
  assert.ok(call.argv.includes("--restricted"));
  assert.equal(flag(call, "--tools"), "Read,Grep,Glob,Bash");
  assert.deepEqual(call.argv.slice(call.argv.indexOf("--allowedTools") + 1, call.argv.indexOf("--allowedTools") + 5), ["Read", "Grep", "Glob", "Bash(ov find:*)"]);
  assert.equal(flag(call, "--add-dir"), project);
  assert.equal(flag(call, "--max-turns"), "12");
  assert.equal(flag(call, "--effort"), "max");
  assert.equal(call.bashTimeoutMs, "12000");
  assert.match(call.stdin, new RegExp(`<project_dir>${project}</project_dir>`));
  assert.deepEqual(card(w).gaps, []);
  await w.dispose();
});

test("only open q1 and q2 goals and today's focus are sent", async () => {
  ownerHome();
  const w = await cardsOn();
  await w.say("t1", "Build the parser");
  await until(() => card(w));
  const { stdin } = cardCalls(w)[0];
  assert.match(stdin, /- \[q1\] Q1-OPEN ship the parser\n- \[q2\] Q2-OPEN write the docs/);
  for (const hidden of ["INBOX-RAW", "Q3-ERRAND", "Q4-SOMEDAY", "Q1-DONE", "NOT-THIS"]) assert.doesNotMatch(stdin, new RegExp(hidden));
  assert.match(stdin, /<focus>\nФокус:\n1\. FOCUS-ONE\n2\. FOCUS-TWO\nДеньги: MONEY-STEP\.\n<\/focus>/);
  await w.dispose();
});

test("a missing matrix and an old brief are recorded as gaps, and the card is still built", async () => {
  ownerHome({ matrix: null, briefs: { [bangkokDay(Date.now() - 30 * HOUR)]: ["1. OLD-FOCUS"] } });
  const w = await cardsOn();
  await w.say("t1", "Build the parser");
  await until(() => card(w));
  const { stdin } = cardCalls(w)[0];
  assert.doesNotMatch(stdin, /OLD-FOCUS/);
  assert.match(stdin, /<focus>\n\(no brief today\)\n<\/focus>/);
  const { gaps } = card(w);
  assert.ok(gaps.some((gap) => gap.startsWith("matrix: ")), JSON.stringify(gaps));
  assert.ok(gaps.includes("focus: no brief today"), JSON.stringify(gaps));
  await w.dispose();
});

test("the run reads each of the owner's prompts after the agent message it answers, then the latest answer", async () => {
  ownerHome();
  const w = await cardsOn({
    threads: {
      t1: { turns: [{ source: "spawn", text: "Build the parser" }, { reply: "PARSER-DONE. Add the CLI next?" }], answer: "CLI-ADDED, try --help." },
      t2: { turns: [{ source: "spawn", text: "Write the docs" }, { reply: "DOCS-DRAFTED. Publish them?" }], answer: "DOCS-DRAFTED. Publish them?" },
    },
  });
  await w.say("t1", "yes, and how often does it run?");
  await w.say("t2", "not yet");
  await until(() => card(w, "t1") && card(w, "t2"));
  const stdinOf = (id) => cardCalls(w).find((call) => call.stdin.includes(`<thread role="root">${id}</thread>`)).stdin;
  assert.match(
    stdinOf("t1"),
    /<recent_conversation>\n\[owner\] Build the parser\n\n\[agent\] PARSER-DONE\. Add the CLI next\?\n\n\[owner\] yes, and how often does it run\?\n\n\[agent, latest answer\] CLI-ADDED, try --help\.\n<\/recent_conversation>/,
  );
  // The thread hasn't answered since: its latest answer is the message the prompt answers, shown once.
  assert.equal(stdinOf("t2").match(/DOCS-DRAFTED/g).length, 1);
  await w.dispose();
});

test("a gap the model restates in its own words is listed once", async () => {
  ownerHome({ briefs: {} });
  const w = await cardsOn({ claude: { card: { output: { ...CARD_DRAFT, gaps: ["focus: брифа на сегодня нет", "ov: timeout", "ov: timeout"] } } } });
  await w.say("t1", "Build the parser");
  await until(() => card(w));
  assert.deepEqual(card(w).gaps, ["focus: no brief today", "project files: not on this machine", "ov: timeout"]);
  await w.dispose();
});

test("suggestions don't wait for a card run, and the next ones carry the card", async () => {
  ownerHome();
  const w = await cardsOn();
  w.claude.answer({ suggest: { output: suggested() }, card: { output: CARD_DRAFT, gate: w.claude.gate("card") } });
  await w.say("t1", "Build the parser");
  await until(() => cardCalls(w).length === 1);
  await w.idle();
  await w.untilReady();
  assert.match(w.claude.calls("suggest")[0].stdin, /<card>\n\(no card yet\)\n<\/card>/);
  w.claude.open("card");
  await until(() => card(w));
  await w.idle("t1", "Another answer.");
  await until(() => w.claude.calls("suggest").length === 2);
  assert.match(w.claude.calls("suggest")[1].stdin, /<card>\nКарточка треда[^]*Задача: Научить подсказки видеть карточку треда/);
  await w.dispose();
});

test("more messages while a card is building don't start another run", async () => {
  ownerHome();
  const w = await cardsOn();
  w.claude.answer({ card: { output: CARD_DRAFT, gate: w.claude.gate("card") } });
  await w.say("t1", "Build the parser");
  await until(() => cardCalls(w).length === 1);
  await w.say("t1", "And the lexer");
  await w.say("t1", "Quickly");
  await sleep(200);
  w.claude.open("card");
  await until(() => card(w));
  await w.say("t1", "Thanks");
  await sleep(300);
  assert.equal(cardCalls(w).length, 1);
  await w.dispose();
});

test("no more than two cards build at once; the third waits its turn", async () => {
  ownerHome();
  const w = await cardsOn({ threads: { a: {}, b: {}, c: {} } });
  w.claude.answer({ card: ["1", "2", "3"].map((n) => ({ output: CARD_DRAFT, gate: w.claude.gate(n) })) });
  for (const id of ["a", "b", "c"]) await w.say(id, "Go");
  await until(() => cardCalls(w).length === 2);
  await sleep(300);
  assert.equal(cardCalls(w).length, 2);
  w.claude.open("1");
  await until(() => cardCalls(w).length === 3);
  w.claude.open("2");
  w.claude.open("3");
  await until(() => ["a", "b", "c"].every((id) => card(w, id)));
  await w.dispose();
});

test("a card from an earlier day is rebuilt on the owner's first message today, today's is not", async () => {
  ownerHome();
  const w = await cardsOn({
    threads: { t1: {}, t2: {} },
    metadata: { t1: { card: stored({ day: "2026-01-01", builtAt: Date.now() - 48 * HOUR }) }, t2: { card: stored({ threadId: "t2" }) } },
  });
  await w.say("t1", "Continue");
  await w.say("t2", "Continue");
  await until(() => card(w).day === TODAY());
  await sleep(200);
  assert.equal(cardCalls(w).length, 1, "only t1's card was rebuilt");
  assert.equal(w.meta().cardAttempt.reason, "new-day");
  await w.dispose();
});

test("a card the suggestions call stale is rebuilt once it is an hour old", async () => {
  ownerHome();
  const flagged = { ...suggested(), cardStale: true, staleReason: "The thread moved to the lexer" };
  for (const [age, rebuilt] of [[10 * 60_000, false], [2 * HOUR, true]]) {
    const w = await cardsOn({ claude: { suggest: { output: flagged } }, metadata: { t1: { card: stored({ builtAt: Date.now() - age }) } } });
    await w.idle();
    await w.untilReady();
    await until(() => typeof w.meta().cardStaleAt === "number");
    await sleep(250);
    assert.equal(cardCalls(w).length, rebuilt ? 1 : 0, `card ${age / 60_000} min old`);
    if (rebuilt) {
      await until(() => w.meta().cardAttempt?.reason === "stale");
      await until(() => w.meta().cardStaleAt === null);
    }
    await w.dispose();
  }
});

test("a failed run is shown, and the next try waits 15 minutes", async () => {
  ownerHome();
  const w = await cardsOn({ claude: { card: { fail: "exit" } } });
  await w.say("t1", "Build the parser");
  await until(() => w.meta().cardAttempt);
  assert.equal(w.meta().cardAttempt.ok, false);
  assert.match((await w.cli("card", "t1")).stdout, /No card for t1 yet\.\nLast build failed at .*: The claude CLI returned no JSON/);
  await w.say("t1", "Try again");
  await sleep(300);
  assert.equal(cardCalls(w).length, 1, "no retry within 15 minutes");
  w.world.metadata.followups.t1.cardAttempt.at = Date.now() - 16 * 60_000;
  w.claude.answer({ card: { output: CARD_DRAFT } });
  await w.say("t1", "Try again");
  await until(() => card(w));
  assert.equal(cardCalls(w).length, 2);
  await w.dispose();
});

test("a reloaded plugin doesn't build today's card again", async () => {
  ownerHome();
  const w = await cardsOn();
  await w.say("t1", "Build the parser");
  await until(() => card(w));
  const next = await w.host.harness.reload(plugin);
  w.addTurn("t1", { text: "More", at: Date.now() });
  await next.harness.emitThreadEvent("thread.active", { thread: w.row("t1") });
  await sleep(300);
  assert.equal(cardCalls(w).length, 1);
  await next.harness.dispose();
  await w.claude.cleanup();
});

test("`card --refresh` builds now and waits; `cards` lists them, by project and day", async () => {
  ownerHome();
  const w = await cardsOn({ metadata: { t1: { card: stored() } } });
  const refreshed = JSON.parse((await w.cli("card", "t1", "--refresh", "--json")).stdout);
  assert.equal(cardCalls(w).length, 1);
  assert.equal(refreshed.card.task, CARD_DRAFT.task);
  assert.equal(refreshed.attempt.reason, "manual");
  assert.equal(JSON.parse((await w.cli("cards", "--json")).stdout).length, 1);
  assert.equal(JSON.parse((await w.cli("cards", "--day", "today", "--project", "p", "--json")).stdout)[0].threadId, "t1");
  assert.deepEqual(JSON.parse((await w.cli("cards", "--day", "2000-01-01", "--json")).stdout), []);
  assert.deepEqual(JSON.parse((await w.cli("cards", "--project", "elsewhere", "--json")).stdout), []);
  assert.equal((await w.cli("cards", "--day", "yesterday")).exitCode, 1);
  await w.dispose();
});

test("`stats` shows what card runs cost, and any refused tool call", async () => {
  ownerHome();
  const w = await cardsOn({ claude: { card: { output: CARD_DRAFT, denials: ["Bash"] } } });
  await w.say("t1", "Build the parser");
  await until(() => card(w));
  const { cards } = JSON.parse((await w.cli("stats", "--json")).stdout);
  assert.equal(cards.runs, 1);
  assert.equal(cards.failed, 0);
  assert.equal(cards.byReason.first, 1);
  assert.equal(cards.inputTokens, 1_000);
  assert.equal(cards.cachedInputTokens, 2_000);
  assert.equal(cards.outputTokens, 300);
  assert.equal(cards.withDeniedTools, 1);
  assert.match((await w.cli("stats")).stdout, /Thread cards: 1 run\(s\), 0 failed, median \d+\.\ds; tokens 1,000 input, 2,000 cached, 300 output; 1 run\(s\) had a tool call refused\./);
  await w.dispose();
});

test("with cards turned off, nothing is built and suggestions get no card", async () => {
  ownerHome();
  const w = await boot({ metadata: { t1: { card: stored() } } });
  await w.say("t1", "Build the parser");
  await w.idle();
  await w.untilReady();
  assert.equal(cardCalls(w).length, 0);
  assert.match(w.claude.calls("suggest")[0].stdin, /<card>\n\(no card yet\)\n<\/card>/);
  assert.equal((await w.cli("card", "t1", "--refresh")).exitCode, 1);
  await w.dispose();
});

test("a thread only agents write in gets no card", async () => {
  ownerHome();
  const w = await cardsOn({ threads: { boss: {}, kid: { parent: "boss" } } });
  w.addTurn("kid", { initiator: "agent", sender: "boss", text: "Also do X", at: Date.now() });
  await w.active("kid");
  await w.idle("kid");
  await sleep(300);
  assert.equal(cardCalls(w).length, 0);
  await w.dispose();
});

test("`cards` finds a card on a thread past the first page, and `--day` keeps the threads updated that Bangkok day", async () => {
  ownerHome();
  const now = Date.now();
  const filler = Object.fromEntries(Array.from({ length: 450 }, (_, i) => [`f${i}`, { createdAt: now - i * 1000 }]));
  const w = await cardsOn({
    threads: { ...filler, old: { createdAt: now - 40 * 24 * HOUR, updatedAt: now - 60_000 }, stale: { createdAt: now - 41 * 24 * HOUR, updatedAt: now - 30 * 24 * HOUR } },
    metadata: { old: { card: stored({ threadId: "old" }) }, stale: { card: stored({ threadId: "stale" }) } },
  });
  assert.deepEqual(JSON.parse((await w.cli("cards", "--json")).stdout).map((c) => c.threadId).sort(), ["old", "stale"]);
  assert.deepEqual(JSON.parse((await w.cli("cards", "--day", "today", "--json")).stdout).map((c) => c.threadId), ["old"]);
  await w.dispose();
});

test("a sibling created long ago but updated within the window is a sibling", async () => {
  ownerHome();
  const now = Date.now();
  const filler = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`f${i}`, { sectionId: "s", createdAt: now - i * 1000, updatedAt: now - 48 * HOUR }]));
  const w = await cardsOn({
    threads: { ...filler, t1: { sectionId: "s", createdAt: now - 1000 }, elder: { sectionId: "s", title: "Elder work", createdAt: now - 90 * 24 * HOUR, updatedAt: now - 5 * 60_000 } },
  });
  await w.cli("card", "t1", "--refresh", "--json");
  assert.match(cardCalls(w)[0].stdin, /sibling: «Elder work»/);
  await w.dispose();
});

// The banner shows three typed follow-ups in the owner's voice, picked from four candidates.
// When the answer ends by asking him something, the first one answers it. The model sees his
// clock, his own prompts and the threads around this one. Run with `npm test`.
import assert from "node:assert/strict";
import test from "node:test";
import { boot } from "./helpers.mjs";

const candidates = (...items) => ({
  candidates: items.map(([kind, label]) => ({ kind, label, why: `Because of ${label}` })),
  cardStale: false,
  staleReason: null,
});
const shownKinds = async (w, id = "t1") => (await w.shown(id)).suggestions.map((s) => s.kind);
const shownLabels = async (w, id = "t1") => (await w.shown(id)).suggestions.map((s) => s.label);
const ASKS = candidates(["continue", "делай ретраи"], ["check", "проверь пустую очередь"], ["answer", "1 — удали, 2 — оставь"], ["close", "коммить"]);

test("the banner shows three of the four candidates, each with its kind", async () => {
  const w = await boot();
  await w.idle();
  await w.untilReady();
  const { suggestions } = await w.shown();
  assert.equal(suggestions.length, 3);
  assert.deepEqual(suggestions.map((s) => s.kind), ["check", "close", "continue"]);
  await w.dispose();
});

for (const [shape, answer] of [
  ["a question", "Fixed the parser.\nWant me to delete the old fixtures?"],
  ["numbered choices", "Two options:\n1. Delete the old fixtures\n2. Keep them as a regression set"],
  ["numbered choices with dashes", "Варианты:\n1 — удалить старые фикстуры\n2 — оставить для регрессии"],
]) {
  test(`an answer that ends with ${shape} gets its answer suggestion first`, async () => {
    const w = await boot({ answers: { suggest: { output: ASKS } }, threads: { t1: { answer } } });
    await w.idle();
    await w.untilReady();
    assert.deepEqual(await shownKinds(w), ["answer", "continue", "check"]);
    assert.match(w.model.calls("suggest")[0].stdin, /<open_questions>yes<\/open_questions>/);
    await w.dispose();
  });
}

test("an answer that asked nothing never gets an answer suggestion", async () => {
  const w = await boot({ answers: { suggest: { output: ASKS } }, threads: { t1: { answer: "Fixed the parser and pushed the branch." } } });
  await w.idle();
  await w.untilReady();
  assert.ok(!(await shownKinds(w)).includes("answer"));
  assert.ok((await shownLabels(w)).includes("делай ретраи"));
  assert.match(w.model.calls("suggest")[0].stdin, /<open_questions>no<\/open_questions>/);
  await w.dispose();
});

test("a suggestion written as the assistant is dropped", async () => {
  const output = candidates(["check", "Сейчас проверю логи"], ["continue", "делай ретраи"], ["close", "коммить"], ["delegate", "I'll split the parser out"]);
  const w = await boot({ answers: { suggest: { output } } });
  await w.idle();
  await w.untilReady();
  assert.deepEqual(await shownLabels(w), ["делай ретраи", "коммить"]);
  await w.dispose();
});

test("two candidates that say the same thing show once", async () => {
  const output = candidates(["continue", "Делай ретраи"], ["check", "делай ретраи!"], ["close", "коммить"], ["delegate", "вынеси парсер"]);
  const w = await boot({ answers: { suggest: { output } } });
  await w.idle();
  await w.untilReady();
  assert.deepEqual(await shownLabels(w), ["Делай ретраи", "коммить", "вынеси парсер"]);
  await w.dispose();
});

test("the model is told the time in Bangkok", async () => {
  const w = await boot();
  await w.idle();
  await w.untilReady();
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date());
  assert.match(w.model.calls("suggest")[0].stdin, new RegExp(`<now>${day}, \\S+, \\d\\d:\\d\\d \\(Asia/Bangkok\\)</now>`));
  await w.dispose();
});

test("it sees the owner's prompts and the task, never an agent's message as his", async () => {
  const w = await boot({
    threads: {
      boss: {},
      kid: {
        parent: "boss",
        turns: [
          { initiator: "user", source: "spawn", text: "Port the parser to zod" },
          { initiator: "agent", source: "tell", sender: "boss", text: "Also bump the version" },
          { initiator: "user", source: "tell", text: "Keep the old error messages" },
        ],
      },
    },
  });
  await w.idle("kid");
  await w.untilReady("kid");
  const { stdin } = w.model.calls("suggest")[0];
  assert.match(stdin, /<first_prompt>\nPort the parser to zod\n<\/first_prompt>/);
  assert.match(stdin, /<owner_prompts>\n\[latest\] Keep the old error messages\n<\/owner_prompts>/);
  assert.doesNotMatch(stdin, /bump the version/);
  assert.match(stdin, /<thread role="worker">kid<\/thread>/);
  await w.dispose();
});

test("it sees the parent, the children and the project's threads from the last day, nothing older or elsewhere", async () => {
  const now = Date.now();
  const w = await boot({
    now,
    threads: {
      t1: { title: "Оркестратор · bb" },
      kid: { parent: "t1", title: "Port the parser", status: "error", updatedAt: now - 5 * 60_000 },
      other: { title: "Fix the sidebar", updatedAt: now - 60 * 60_000 },
      old: { title: "Last week's audit", updatedAt: now - 3 * 24 * 60 * 60_000 },
      elsewhere: { title: "Another project's work", projectId: "q" },
    },
  });
  await w.idle("t1");
  await w.untilReady("t1");
  const { stdin } = w.model.calls("suggest")[0];
  const siblings = /<siblings>\n([\s\S]*?)\n<\/siblings>/.exec(stdin)[1];
  assert.match(siblings, /child: «Port the parser» — error, 5 min ago/);
  assert.match(siblings, /sibling: «Fix the sidebar» — idle, 60 min ago/);
  assert.doesNotMatch(siblings, /audit|Another project/);
  assert.match(stdin, /<thread role="orchestrator">/);
  await w.dispose();
});

test("in a section, the threads around it come from that section", async () => {
  const w = await boot({
    threads: {
      t1: { sectionId: "s1" },
      mate: { sectionId: "s1", title: "Same section" },
      stranger: { title: "Same project, no section" },
    },
  });
  await w.idle();
  await w.untilReady();
  const { stdin } = w.model.calls("suggest")[0];
  assert.match(stdin, /Same section/);
  assert.doesNotMatch(stdin, /Same project, no section/);
  await w.dispose();
});

test("`bb followups show` lists each suggestion's kind", async () => {
  const w = await boot();
  await w.idle();
  await w.untilReady();
  assert.match((await w.cli("show", "t1")).stdout, /• \[check\] Add a test for the empty queue/);
  await w.dispose();
});

test("clicking an answer suggestion tells the draft it is one", async () => {
  const w = await boot({ answers: { suggest: { output: ASKS } }, threads: { t1: { answer: "Delete them?\n1. yes\n2. no" } } });
  await w.idle();
  await w.untilReady();
  const [first] = (await w.shown()).suggestions;
  await w.rpc("followups_expand", { threadId: "t1", id: first.id });
  assert.match(w.model.calls("draft")[0].stdin, /<picked kind="answer">1 — удали, 2 — оставь<\/picked>/);
  await w.dispose();
});

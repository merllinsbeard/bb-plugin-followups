# The thread card, v1

Followups keeps a short card for each thread the owner writes in: what the thread is
for, what its project does, which of the owner's goals it moves, and earlier decisions
that bear on it. Suggestions and drafts read it, and so can any other plugin, script or
agent. This file is the contract for those readers.

## Where it is

Key `card` in the thread's plugin metadata for plugin id `followups`. It is the only
supported key in that namespace; the others are private to Followups and change without
notice. Followups is the card's only writer. bb does not enforce either rule, so readers
must not write the key.

A card is built in the background on the owner's first message of the day in a thread
(and when a suggestion call finds it contradicts the conversation), so a thread only
agents write in has none, and a card can be up to a day old. Read `builtAt` and `day`.

## Fields

| Field | Type | Meaning |
| --- | --- | --- |
| `v` | `1` | Version. Any other value means "no card" to a v1 reader. |
| `threadId` | string | The thread. |
| `projectId` | string | Its bb project. |
| `builtAt` | number | Epoch ms when the run finished. |
| `day` | string | `builtAt` as a date in Asia/Bangkok, `YYYY-MM-DD`. |
| `role` | `"orchestrator" \| "worker" \| "root"` | Set by the plugin: a title starting `Оркестратор ·`, else a child thread, else a root thread. |
| `project` | string ≤200 | What the project does, one line. |
| `task` | string ≤280 | What this thread is for, one or two lines. |
| `goals` | string[] ≤3, each ≤200 | The owner's open priority goals this thread moves, each with how and its source (`q1`, `q2`, `фокус`). |
| `decisions` | string[] ≤4, each ≤200 | Earlier decisions or preferences that bear on the thread, each with a source hint. |
| `siblings` | string ≤300 | What the parent, children or neighbouring threads are doing that matters here; may be empty. |
| `focusFit` | string ≤200 | How the thread sits against the owner's focus for the day. |
| `gaps` | string[] ≤6, each ≤80 | Sources that failed during the run, e.g. `matrix: …`, `ov: timeout`. |

Text fields are in Russian. Fields are only ever added within v1; a change that removes
or redefines one bumps `v`.

## Reading it

Parse tolerantly: check `v` and the fields you use, and let unknown fields through, so an
added field never turns a card into "no card".

```ts
import { z } from "zod";

const cardReader = z.looseObject({ v: z.literal(1), task: z.string(), builtAt: z.number() });

const meta = await bb.sdk.threads.getPluginMetadata({ threadId, pluginId: "followups" });
const parsed = cardReader.safeParse(meta?.card);
const card = parsed.success ? parsed.data : null; // null: no card yet, or another version
```

Many threads at once: `bb.sdk.threads.experimental_listPluginMetadata({ pluginId:
"followups", threadIds })` (up to 200 ids per call) and the same reader on each entry's
`metadata.card`.

From a shell:

```sh
bb followups card <thread-id> --json        # { threadId, card, attempt, building, queued }
bb followups cards --day today --json       # cards built today, newest first
bb followups cards --project <id> --json
```

## What goes into it

Plugin code gathers the exact and private parts before the model runs: the Bangkok
clock, the thread's first prompt and the owner's own last prompts, up to eight threads
around it, the owner's open «Срочно и важно» and «Важно, несрочно» cards from the task
matrix (`otask matrix`; nothing else from it ever leaves the plugin), and today's
«Фокус» and «Деньги» from the morning brief when there is one for today.

The model (the plugin's `model` and `effort` settings, through `claude -p` on the
owner's login) may then read files under the thread's environment directory and run
`ov find` against the owner's memory, and nothing else: `--restricted`, the tools
`Read Grep Glob Bash`, only `Bash(ov find:*)` allowed, `--add-dir` the environment
path, at most 12 turns, each `ov find` cut off after 12 s, the run after 240 s.
`bb followups stats` shows what card runs cost and whether any tool call was refused.

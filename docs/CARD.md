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
clock, the thread's first prompt, the owner's own last prompts each after the agent
message it answers, the thread's latest answer, up to eight threads
around it, the owner's open «Срочно и важно» and «Важно, несрочно» cards from the task
matrix (`otask matrix`; nothing else from it ever leaves the plugin), and today's
«Фокус» and «Деньги» from the morning brief when there is one for today.

Every card uses the plugin's `model` and `effort` settings. The default is
`codex/gpt-6-luna@max` through the owner's ChatGPT login. Claude remains
selectable by model name. Code gathers the same packet for either provider.

## Exploration limits

| Capability | Claude | Codex |
| --- | --- | --- |
| Project reads | Restricted Read, Grep, and Glob with the environment path added | Instructed to read only the project. Other host-readable paths remain accessible. |
| Commands | Bash allowlist permits `ov find` | Instructed to run only `ov find`. Network access can reach other services and writable remote APIs. |
| Steps | CLI enforces 12 turns. Prompt requests at most 8 tool calls. | Both the 12-step ceiling and 8-tool budget are instructions. |
| Per-command timeout | Bash timeout variables enforce 12 seconds | Instructed to request a 12-second timeout. |
| Whole call | Parent enforces 240 seconds and kills the process group | Parent enforces 240 seconds and kills the process group |
| Writes | Existing restricted tool policy | Workspace-write sandbox, private cwd, child TMPDIR under cwd, no `--add-dir`. Excludes `/tmp` and inherited TMPDIR from writable roots. No-write behavior outside those sandbox limits is instructed. |
| Other features | Strict empty MCP configuration and no user setting sources | Apps, plugins, memories, skill search, tool suggestions, delegation, images, browser, goals, and sleep disabled. Web search disabled. |

Codex uses `model_instructions_file` for the purpose's system text and reads
source material from stdin. Flags are pinned to codex-cli 0.163.0. Native
suppression reduces available capabilities. Code-mode `exec` remains and is
not visible in JSONL. This is not a proven zero-tool boundary, including for
suggestions and drafts, which also disable `shell_tool` and `unified_exec`
and use a read-only sandbox.

Each call owns private temporary files. Timeout and cancellation kill the
process group, wait for close, and remove those files. A host crash can leave
a child or files. There are no automatic retries or provider fallback.

`bb followups stats` counts recorded tool refusals in `withDeniedTools`.
Codex does not report equivalent refusals or a comparable `turns` count, so
neither is synthesized. Missing refusals do not prove that a run stayed in
scope. Codex input usage excludes cache hits. Reasoning tokens are a subset
of output tokens and are not added again to the total. Older stored stats
remain readable.

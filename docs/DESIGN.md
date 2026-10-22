# Followups: design notes

How Followups decides where and what to suggest, how it calls the model, how
thread cards are built, and what it learns. The [README](../README.md) is the
short version; this is the detail behind it, kept for maintainers.

## Overview

When a visible thread the owner has written in goes idle, the server makes one
`claude -p` call for four typed candidate follow-ups, keeps three, and stores
them in the thread's plugin metadata; the banner reads them over RPC and
refreshes on a realtime signal. Clicking a follow-up makes a second call that
expands it into a full first-person message, which goes into the composer. The
plugin never sends anything. In the background, the owner's first message of
the day in a thread builds that thread's card ([CARD.md](CARD.md)), which later
calls read.

## Whose thread it is

- **Turn authors.** Each `client/turn/requested` event says who asked for the
  turn. `initiator: system` is a child's report; `agent`, or any sender thread,
  is another agent's `bb thread tell`; a `user` turn with no sender is the
  owner, except the thread's start turn: bb records `spawn | user | no sender`
  both when the owner starts a thread in the app and when an agent, cron or
  script runs `bb thread spawn`.
- **How a thread was started.** Only the `message.dispatch` hook's `origin`
  (`app`, `cli`, `plugin`, `sdk`) separates those, and it is null for every
  later message. `lib/start-origin.ts` records it for a pending thread's start
  turn and writes it to metadata `startOrigin` after the hook returns. The hook
  is fail-closed and runs under a server-wide lock, so the handler is
  synchronous, never throws and always proceeds. For threads started before
  this was recorded, a start turn counts as the owner's unless the thread has a
  parent or a plugin origin.
- **The ledger.** `lib/thread-context.ts` `scan` reads only the turn requests
  after the last one it saw (paged, at most 20 pages a scan) and stores
  `{scannedSeq, lastOwnerSeq, lastOwnerAt}` under metadata `turns`. It runs when
  a thread goes active, before each suggestion call, and on the first look at a
  thread's banner; one scan at a time per thread, and a call made during one
  gets a fresh scan after it. If the turns can't be read, the stored ledger
  decides, and a thread never scanned gets nothing.
- **The rule.** A thread's own switch (`on`/`off` in metadata `override`) wins;
  otherwise it gets follow-ups once the ledger has an owner turn. Hidden
  threads never do.

## The suggestions

- **What the model sees** (`lib/suggest.ts`): the time in Bangkok, the thread's
  role and title, its card (rendered with its age) or "no card yet", its first
  prompt (whoever wrote it, ≤2,500 chars), the owner's last three prompts
  (1,500 for the latest, 400 for the others; agents' messages never count as
  his), the answer cut in the middle to 6,000 chars so its closing offers and
  questions survive, up to eight threads around it (parent, children, then
  threads updated in the last day from the same section, or the same project
  when the thread has no section), and up to ten of his recent picks.
- **What it returns.** Exactly four candidates `{label ≤64, kind, why ≤140}` and
  `cardStale` with an optional reason, checked against a schema. Kinds are
  `answer`, `continue`, `refocus`, `check`, `delegate`, `close`.
- **Open questions** are detected in code: a line ending in "?" or at least two
  numbered options in the answer's last 800 characters. The model is told the
  result; without open questions an `answer` candidate is relabelled
  `continue`, with them the first `answer` goes first.
- **Picking three.** Labels written as the assistant ("I'll…", "Сейчас
  сделаю…") and duplicates are dropped, distinct kinds are preferred, then the
  rest in the model's order. Fewer than three show only when more than one
  candidate was dropped.
- **Drafts** get the same context, the picked label, kind and reason, and the
  answer cut to 8,000 chars; they are cleaned of quotes, fences and "Here's the
  message:". A failed draft hands back the short label with `drafted: false`.
- **When a thread counts as finished.** A running thread gets none, and the
  banner is hidden while the agent runs. A thread whose child threads are
  still working (looked up through `parentThreadId`, hidden children included,
  up to four generations down; queued, starting and stopping count as working)
  counts as still running even though its own agent is idle. When its last
  descendant stops, the parent is given five seconds to be woken by that
  report; if it stays idle, its follow-ups are drafted then. A child that
  starts while the follow-ups are being drafted holds them back. If the
  children can't be looked up, follow-ups are drafted anyway and a warning is
  logged.
- **A thread whose last message is the request itself** (it went idle before
  replying, so bb's "last assistant text" is that message) gets no follow-ups.

## Model calls

- **One spawner.** `lib/claude.ts` `callClaude` is the only code that starts a
  process. Each call is `claude -p --output-format json --json-schema …` with
  the model and effort from settings, `--setting-sources ""`,
  `--strict-mcp-config`, `--disable-slash-commands`,
  `--no-session-persistence`, the prompt on stdin, in a fresh empty temporary
  directory removed afterwards, with the plugin's `BB_*` variables left out of
  its environment. Suggestions and drafts add `--tools ""`. The JSON result's
  `structured_output` is parsed with the same schema the flag was derived
  from; `is_error`, unreadable output and a schema mismatch are failures.
  `stats` (time, tokens, turns, refused tools) come from the same result.
- **At most four suggestion calls at once.** A burst of threads finishing
  together queues. A call waiting its turn shows nothing; one whose thread
  moves on while it waits never starts. Draft calls are never held up.
- **Stopping stale work.** When the thread goes active, a message is queued or
  dispatched, the banner is dismissed, follow-ups are turned off, or the thread
  goes away, the call is aborted and its process group killed at once, and the
  banner is left empty rather than "working". A newer answer queued behind a
  call in flight stops it and starts at once. A result that still arrives for
  an outdated answer is dropped. A draft call is treated the same way, except
  for a queued newer answer; `followups_expand` then rejects with "That
  follow-up is no longer available" rather than hand a stale draft over.
- **Reloading.** Disposing the plugin aborts every call in flight and the card
  runs, kills their processes, and nothing writes afterwards.

## Thread cards

- **Triggers** (`lib/card.ts` `cardDue`): `first` when the owner wrote today
  and there is no card (old threads he has not written in today get none on
  first sight, so opening them never starts a run); `new-day` when he wrote
  today and the card is from an earlier day; `stale` when a suggestion call
  flagged the card (metadata `cardStaleAt`) and it is at least an hour old;
  `manual` for `card --refresh`. Any attempt in the last 15 minutes blocks the
  automatic ones, so a failing run never loops. Triggers are evaluated on new
  owner turns and stale flags, never block, and queue at most one run per
  thread; `cardRuns` (1–3) run at once. Nothing about the queue is persisted:
  after a restart the next owner turn derives the trigger again, and a run that
  dies writes nothing.
- **The packet**, gathered by code: the thread context above, the open q1/q2
  cards of `otask matrix` (5 s cap; nothing else from the matrix leaves the
  plugin), today's «Фокус» and «Деньги» from the newest morning brief when it is
  today's, the environment path when it exists on this machine, and the
  previous card. Failed sources become `gaps`.
- **The run**: `callClaude` with `--restricted`, `--tools Read,Grep,Glob,Bash`,
  `--allowedTools Read Grep Glob "Bash(ov find:*)"`, `--add-dir` the
  environment path, `--max-turns 12`, each Bash command capped at 12 s through
  `BASH_DEFAULT_TIMEOUT_MS`/`BASH_MAX_TIMEOUT_MS`, and a 240 s timeout. The
  model fills `project`, `task`, `goals`, `decisions`, `siblings`, `focusFit`
  and its own gaps; the plugin adds the ids, `builtAt`, `day` and `role` and
  writes the card, the attempt and a cleared stale flag in one metadata write.
- **The run log**: each finished run adds a row to `card_runs` in the plugin's
  SQLite database (reason, ok, error, ms, tokens, turns, refused tools; newest
  500 rows, 30 days), summarised by `bb followups stats`.

## Learning

`lib/learning.ts` keeps one batch per banner in the plugin's SQLite database:
what was shown, which suggestion was clicked and its draft, whether the banner
was dismissed, and what the owner sent next. His next turn, as the scan first
sees it, closes the batch: the same text as the draft is `sent-as-is`, a word
overlap of at least half is `sent-edited`, anything else (or no click) is
`own-message`. A banner replaced before he wrote is `unanswered`. Only the
banner's click counts as a pick; `bb followups draft` is a diagnostic. The
newest five answered batches of the thread and five of the project go into
prompts. Texts are kept for the newest ten batches per thread and per project,
rows for 90 days. All statements of the plugin's database are one migration
list in `server.ts`, because the host numbers them by index.

## Clearing and the per-thread switch

- **Clearing.** Queued or dispatched messages and the thread going active again
  wipe the stored follow-ups, so the banner clears when the owner sends a
  message. Clearing only writes and broadcasts when something is showing or
  being drafted.
- **The switch.** `followups_set_enabled`, `bb followups on|off <thread-id>`
  and the button in the thread header store the thread's own choice, which
  beats the owner rule either way. `followups_get` reports the effective
  `enabled`. Turning a thread off clears what it shows and drops a call in
  flight; turning it on drafts from its latest answer right away if the thread
  has finished and shows none. The choice is read apart from the stored
  follow-ups, so unreadable stored data never turns an off thread back on; if
  it can't be read at all, no call is made and a warning is logged.

## Where the code lives

- `server.ts` — events, gates, storage, RPC (`followups_get`,
  `followups_set_enabled`, `followups_expand`, `followups_dismiss`), settings
  (`model`, `effort`, `card`, `cardRuns`) and the CLI. A `working` state older
  than the call timeout plus 45 s is reported as `empty`.
- `lib/claude.ts`, `lib/start-origin.ts`, `lib/thread-context.ts`,
  `lib/suggest.ts`, `lib/learning.ts`, `lib/card.ts`, `lib/card-contract.ts` —
  as described above.
- `app.tsx` — the frontend: a `Follow-ups` panel above the thread composer
  (`app.composer.customize`): a header (title, count, fold/unfold chevron,
  dismiss) over a grid of numbered tiles (two columns when wide, one when
  narrow); the arrow keys move between tiles, 1–9 draft that tile, Esc returns
  focus to the composer. While suggestions are being found it shows skeleton
  tiles. Clicking a tile writes the draft with `composer.replace` and focuses the
  composer. Never sends, and never discards what the user typed: an empty
  composer (or a draft the banner wrote itself and the user hasn't edited) is
  replaced, anything else gets the new draft appended. The in-flight draft can be
  cancelled, and is dropped if its follow-up goes away first.
  The per-thread switch is a button in the thread header's action row
  (`app.slots.experimental_threadHeaderAction`); a slash over the icon means off.
- `lib/banner-memory.ts` — what the banner remembers per thread, outside the
  component: the message being written, the drafted tile, the draft's cost, and
  the composer text it wrote itself. bb rebuilds the message box (on some
  resizes, and whenever a thread is left and come back to), and a rebuilt banner
  reads the same memory, so none of it is forgotten.
- `lib/banner-collapse.ts` — stores the expanded batch's suggestion ids per
  thread in local storage. Opening that batch survives thread switches and
  plugin reloads; new batches start collapsed.
- `components/glyph.tsx` — icons drawn straight from
  `@hugeicons/core-free-icons` (a runtime `dependency`, because a
  `bb plugin install git:` build installs without devDependencies). BB's `Icon`
  only knows a subset, and a name outside it silently renders as a ⚡.
- `skills/followups/SKILL.md` — tells agents the banner is the user's surface,
  and how to read follow-ups, cards and stats.
- `docs/CARD.md` — the card contract for other readers.
- `PLUGIN_OVERVIEW.md` — the store listing text. `CHANGELOG.md` — what changed.

## Tests

`npm test` runs everything on the SDK's fake plugin host; `tests/helpers.mjs`
builds a fake bb (threads, their turn events, plugin metadata, environments)
and puts `tests/fake-claude/claude` first on `PATH`. The fake CLI logs argv,
stdin, cwd and the Bash timeout of each call and answers per call kind from
fixtures, with delays, gates, failures, usage and refused tools.

- `lean-call.test.mjs` — the flags of every call, the default model and effort,
  stdin and the removed temporary directory, failures, schema mismatches, a
  missing CLI, drafts, `model`/`model-clear`, and a reload killing calls.
- `owner-turns.test.mjs` — the turn-author table, agent-only children, an owner
  message turning a child on, long histories, `on`/`off` overriding the rule,
  and unreadable turns.
- `start-origin.test.mjs` — CLI-started and app-started threads, the hook always
  proceeding at once whatever it is handed, only a pending thread's first
  message recorded, and a failed write.
- `suggestions.test.mjs` — three tiles with kinds, `answer` first after
  questions and never without them, assistant voice and duplicates dropped, the
  Bangkok clock, the owner's prompts only, the threads around, sections.
- `learning.test.mjs` — sent as drafted, edited, own message, unanswered,
  dismissals, examples in the next prompt, `stats` filters, a reload, pruning
  and retention.
- `cards.test.mjs` — one card on the first message today and its v1 shape, the
  run's confinement flags, only open q1/q2 goals and today's focus sent, gaps,
  suggestions not waiting for a run, coalescing, the two-run cap, new-day and
  stale rebuilds, failure backoff, a reloaded plugin, `card --refresh`,
  `cards`, card costs in `stats`, cards off, agent-only threads.
- `stale-call.test.mjs` — each trigger kills the call at once, a newer answer
  doesn't wait, outdated results are dropped, and the same for drafts.
- `call-limit.test.mjs` — at most four suggestion calls at once, in order.
- `active-children.test.mjs` — threads with child threads.
- `thread-toggle.test.mjs` — the per-thread switch and its CLI.
- `legacy-cleanup.test.mjs` — deleting the hidden worker threads of earlier
  releases.
- `robustness.test.mjs` — clearing only when something shows, reloads with
  work in flight, unreadable stored data, the request read back as an answer,
  and the skill every agent gets.
- `banner-memory.test.mjs`, `banner-collapse.test.mjs` — the banner's memory
  and collapse state.

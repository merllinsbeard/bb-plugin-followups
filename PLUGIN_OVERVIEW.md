Suggest clickable follow-up prompts above the composer when a thread finishes.

## What you get

- A **Follow-ups** panel above a thread's message box with three suggestions
  drawn from the thread's last finished answer: a grid of numbered tiles under
  a header with a count (two columns when there's room, one when it's narrow).
  It starts collapsed to just the header; click the header to show the
  suggestions. That set stays expanded across thread switches and plugin
  reloads until you collapse it; new suggestions start collapsed.
- Suggestions in your voice, each of a kind (answer, continue, check, refocus,
  delegate, close) with a short reason under the label. When the answer ends
  with questions or numbered options, the first tile answers them all.
- Only where you write: a thread gets follow-ups once you have written in it.
  Threads only agents, crons or plugins write in stay quiet. The button in a
  thread's header turns follow-ups on or off for it either way (a slash over
  the icon means off).
- A card per thread you write in, built in the background: its task, its
  project, which of your goals it moves, and earlier decisions. Suggestions
  read it, and so can other plugins.
- It learns what you pick: your recent picks and what you actually sent go
  into the next suggestions.
- See what each run cost: a footer reads "Generated in 4.2s · 37,275 tokens"
  for the suggestions, with a second line for the draft once you've picked
  one. Open Details for the token split and the model.
- Keyboard: the arrow keys move between tiles, 1–9 draft that tile, Esc
  returns to the composer.
- Clicking a follow-up expands it into a full, ready-to-send draft in the
  composer. Nothing ever sends on your behalf, and your own words are safe:
  the draft goes into an empty composer, or is added below what you've
  already typed. Slow draft? Cancel it from the banner.
- Follow-ups wait until a thread is really done: while its child threads are
  still working, the thread counts as running and shows none.
- Sending any message clears the banner. The ✕ dismisses it early.
- A `bb followups` command: `show` and `clear` a thread's follow-ups, switch
  one thread `on` or `off`, read a thread's `card` or many `cards`, see
  `stats`, check the `model`.

## How it works

When a thread you write in goes idle, the server makes one `claude -p` call on
your own Claude login, with no tools, for four candidate follow-ups, keeps the
best three and stores them in the thread's plugin metadata. The banner reads
them over RPC and refreshes on a realtime signal. Clicking one makes a second
call that writes the full first-person message. On your first message of the
day in a thread, a background run builds the thread's card: it may read the
project's files and search your memory with `ov find`, nothing else.

## Cost and safety

Nothing is ever sent for you, and a draft never overwrites what you typed.
Each suggestion, draft and card is a run on your Claude login (Haiku 5.5 at
max effort by default), so it uses your plan; at most four suggestion calls
and two card runs go at once, and the footer and `bb followups stats` show
what they cost. Suggestion and draft calls have no tools and run in an empty
temporary directory. Card runs are read-only and confined to the thread's
project directory and `ov find`.

## For agents

Agents do not write follow-ups: the banner is the user's surface. The bundled
skill tells an agent to leave it alone, inspect it with `bb followups show`
when asked, and read a thread's card with `bb followups card`.

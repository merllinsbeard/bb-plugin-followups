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

When a thread you write in goes idle, the server calls the selected model for
four candidate follow-ups, keeps the best three, and stores them in thread
metadata. Clicking one makes a second call that writes the message. The first
message of the day also starts a background card run. All three use the same
model and effort settings.

## Cost and safety

Nothing is sent for you. Drafts preserve what you typed. Calls default to
`gpt-6-luna` at `max` through `codex exec` on your ChatGPT login. A `claude-*`
model or the `haiku`, `sonnet`, and `opus` aliases selects your Claude login.
Existing saved Claude models remain valid. Details shows the provider, model,
effort, and token split. At most four suggestion calls and two card runs run
at once by default.

Claude disables tools for suggestions and drafts and restricts card readers
and `ov find`. Codex suppresses native features and uses a private sandbox,
but code-mode `exec` remains. Card read scope, allowed commands, step budget,
and per-command timeout are instructions on Codex. Its network-enabled card
sandbox can reach other host-readable files and remote APIs. The plugin
enforces whole-call deadlines and kills the process group on timeout or
cancellation. See `docs/CARD.md` for the exact limits.

## For agents

Agents do not write follow-ups: the banner is the user's surface. The bundled
skill tells an agent to leave it alone, inspect it with `bb followups show`
when asked, and read a thread's card with `bb followups card`.

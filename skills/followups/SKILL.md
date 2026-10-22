---
name: followups
description: Inspect the Followups plugin with the `bb followups` CLI - the follow-ups suggested for a thread, a thread's card (its task, project, related goals and earlier decisions), and how often suggestions were used. Use when the user asks what was suggested, wants them cleared, or when you need a thread's card.
---

# Follow-ups

The Followups plugin suggests three follow-up prompts when a thread the user
writes in finishes, and shows them as clickable tiles in a banner above that
thread's composer. Clicking one expands it into a full draft in the composer;
the plugin fills the draft, it never sends. Sending any message clears the
banner. Threads only agents, crons or plugins write in get no follow-ups unless
the user switched them on.

Agents never need to write follow-ups by hand: the banner belongs to the user.
These commands are for inspection, debugging, and reading thread cards.

## Commands

| Command | Effect |
| --- | --- |
| `bb followups show <thread-id>` | The stored follow-ups with their kinds, plus how long they took and the tokens used; or why the thread gets none. |
| `bb followups clear <thread-id>` | Clear the stored follow-ups for a thread. |
| `bb followups on <thread-id>` / `off <thread-id>` | Turn follow-ups on or off for one thread (the user's button in the thread header does the same). Only on the user's request; `on` drafts right away for a finished thread, which makes a model call. |
| `bb followups card <thread-id>` | The thread's card: what it is for, its project, the user's goals it moves, earlier decisions, today's focus fit, and missing sources. |
| `bb followups cards [--project <id>] [--day today\|YYYY-MM-DD]` | Cards of many threads, newest first. |
| `bb followups stats [--days <n>] [--project <id>]` | How often a suggestion became the user's message, by kind, and what card runs cost. |
| `bb followups model` | The model and effort every call uses. |
| `bb followups cleanup --dry-run` | List the hidden worker threads earlier releases left behind. Run it without `--dry-run` only when the user asks. |

`bb followups regenerate`, `bb followups draft` and `bb followups card --refresh`
each make a real model call, so run them only when the user asks (for example
to time the pipeline). `regenerate` only works on a thread that gets follow-ups
and has finished, which includes having no child threads still running.

A card is context, not a source of facts about what was done: read it to learn
what a thread is for, and check the thread itself before reporting progress.
Other plugins read the card from thread metadata as described in `docs/CARD.md`
in the plugin's source.

The settings (`model`, `effort`, `card`, `cardRuns`) are the user's choice.
Never change them on your own; point the user to Settings → Installed plugins →
Followups if they ask.

Add `--json` to any command when the output drives code.

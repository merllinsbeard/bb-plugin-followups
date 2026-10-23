// bb-plugin-followups — suggest what to do after a thread finishes.
//
// When a visible thread the owner has written in goes idle, the server asks the
// selected model CLI for short follow-up prompts drawn from the finished answer
// and the thread around it. Threads only agents have written
// in get none unless switched on. The banner above the thread composer (app.tsx)
// shows them as clickable buttons. Clicking one asks for the full, ready-to-send
// composer draft — the plugin fills the composer, it never sends for you.
// Sending any message first clears the banner instead.

import { randomUUID } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  callModel, DEFAULT_MODEL, DEFAULT_EFFORT, describeModel, EFFORTS, ModelCallError, readModelChoice,
  type CallStats, type ModelChoice,
} from "./lib/model.ts";
import { CARD_RUN_MIGRATIONS, createCardService, type CardRunSummary, type CardStatus } from "./lib/card.ts";
import { renderCard } from "./lib/card-contract.ts";
import { LEARNING_MIGRATIONS, openLearning, type AcceptanceStats, type Learning } from "./lib/learning.ts";
import { createStartOriginStore } from "./lib/start-origin.ts";
import {
  cleanDraft,
  draftCall,
  KINDS,
  openQuestions,
  pickThree,
  suggestCall,
  SUGGEST_TIMEOUT_MS,
  type LearningExample,
} from "./lib/suggest.ts";
import {
  bangkokNow,
  createThreadContextReader,
  ledgerSchema,
  META_TURNS,
  wantsFollowups,
  type Override,
  type TurnLedger,
} from "./lib/thread-context.ts";

const suggestionSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** What kind of next step it is (lib/suggest.ts KINDS); absent on ones stored by older releases. */
  kind: z.enum(KINDS).optional(),
  /** Why this follow-up was suggested; absent when the model gave none (or for older stored ones). */
  why: z.string().optional(),
});
export type FollowupSuggestion = z.infer<typeof suggestionSchema>;

/** What one model call cost: wall-clock time plus its token usage. Token fields are absent when none was reported. */
const statsSchema = z
  .object({
    ms: z.number(),
    /** `<provider>/<model>@<effort>` that ran it. */
    model: z.string(),
    totalTokens: z.number().optional(),
    inputTokens: z.number().optional(),
    cachedInputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    reasoningOutputTokens: z.number().optional(),
  })
  .strict();
export type FollowupStats = z.infer<typeof statsSchema>;

export const rpcContract = defineRpcContract({
  followups_get: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z
      .object({
        status: z.enum(["empty", "working", "ready"]),
        suggestions: z.array(suggestionSchema),
        updatedAt: z.number(),
        /** Cost of the run that produced `suggestions`; null while none is known. */
        stats: statsSchema.nullable(),
        /** Whether follow-ups are on for this thread: its own choice, else whether the owner has written in it. */
        enabled: z.boolean(),
      })
      .strict(),
  },
  followups_set_enabled: {
    input: z.object({ threadId: z.string().min(1), enabled: z.boolean() }).strict(),
    output: z.object({ enabled: z.boolean() }).strict(),
  },
  followups_expand: {
    input: z.object({ threadId: z.string().min(1), id: z.string().min(1) }).strict(),
    // `drafted` is false when the call failed and `text` is just the short label.
    output: z
      .object({ text: z.string(), drafted: z.boolean(), stats: statsSchema.nullable() })
      .strict(),
  },
  followups_dismiss: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({ dismissed: z.boolean() }).strict(),
  },
});

/** Ephemeral broadcast; a `{ threadId }` payload refreshes that thread's banner. */
const FOLLOWUPS_CHANGED = "followups-changed";

const META_SUGGESTIONS = "suggestions";
const META_STATUS = "status";
const META_UPDATED_AT = "updatedAt";
const META_STATS = "stats";
/** "on" or "off": this thread's own choice. Absent means the owner rule decides. */
const META_OVERRIDE = "override";

const DEFAULT_CARD_RUNS = 2;

/**
 * The plugin database's one migration list: the host numbers statements by their index, so
 * every module's statements go here, new ones at the end, shipped ones never edited.
 */
const MIGRATIONS = [...LEARNING_MIGRATIONS, ...CARD_RUN_MIGRATIONS];
/**
 * Suggestion calls running at once. Every visible thread that finishes gets one,
 * so a burst (an agent team finishing together) would otherwise start a model
 * process for each thread at the same moment. The rest wait their turn. The
 * message draft for a follow-up the user clicked is never held up by this.
 */
const MAX_CONCURRENT_DRAFTS = 4;
/**
 * A "working" state older than this was left behind by a crash or restart
 * (the call timeout would have settled it); report it as empty so the
 * banner doesn't spin forever.
 */
const WORKING_STALE_MS = SUGGEST_TIMEOUT_MS + 45_000;

/**
 * A thread whose child threads are still working isn't finished: its own agent is
 * idle only because it is waiting on them. These are the statuses that count as
 * still working (a child that is queued to start, or winding down, included);
 * the check looks this many generations down and makes at most this many lookups.
 */
const BUSY_STATUSES = new Set<string>(["active", "starting", "pending", "stopping"]);
const DESCENDANT_DEPTH = 4;
const DESCENDANT_LOOKUPS = 60;
/** After the last child stops, wait this long for the parent to be woken by its report before drafting for it. */
const CHILD_SETTLE_MS = 5_000;

/** Hidden threads earlier releases spawned to draft follow-ups; `bb followups cleanup` deletes them. */
const LEGACY_WORKER_TITLES = new Set(["Followups suggestions", "Followups draft", "Followups worker"]);
const LEGACY_PAGE = 100;
const LEGACY_SCAN_LIMIT = 2_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `--days <n>` (default 7) and `--project <id>`; null for anything else. */
function statsOptions(args: string[]): { days: number; projectId?: string } | null {
  let days = 7;
  let projectId: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const [name, value] = [args[index], args[index + 1]];
    if (value === undefined) return null;
    if (name === "--days" && /^\d+$/.test(value) && Number(value) > 0) days = Number(value);
    else if (name === "--project") projectId = value;
    else return null;
  }
  return projectId === undefined ? { days } : { days, projectId };
}

function describeStats(stats: AcceptanceStats, projectId: string | undefined): string {
  const scope = projectId === undefined ? "" : ` in project ${projectId}`;
  const percent = stats.acceptance === null ? "n/a" : `${Math.round(stats.acceptance * 100)}%`;
  const kinds = Object.entries(stats.byKind)
    .filter(([, count]) => count.shown > 0)
    .map(([kind, count]) => `${kind} ${count.shown}/${count.picked}`);
  return [
    `Last ${stats.days} day(s)${scope}: ${stats.batches} banner(s) in ${stats.threads} thread(s).`,
    `Answered ${stats.answered}: ${stats.sentAsIs} sent as drafted, ${stats.sentEdited} edited, ${stats.ownMessage} own message(s). Acceptance ${percent}. Dismissed ${stats.dismissed}.`,
    kinds.length > 0 ? `By kind (shown/picked): ${kinds.join(", ")}.` : "Nothing shown yet.",
  ].join("\n");
}

function describeCardRuns(summary: CardRunSummary | null): string {
  if (summary === null || summary.runs === 0) return "Thread cards: no runs.";
  const seconds = summary.p50Ms === null ? "n/a" : `${(summary.p50Ms / 1000).toFixed(1)}s`;
  return (
    `Thread cards: ${summary.runs} run(s), ${summary.failed} failed, median ${seconds}; ` +
    `tokens ${summary.inputTokens.toLocaleString("en-US")} input, ${summary.cachedInputTokens.toLocaleString("en-US")} cached, ` +
    `${summary.outputTokens.toLocaleString("en-US")} output` +
    (summary.withDeniedTools > 0 ? `; ${summary.withDeniedTools} run(s) had a tool call refused.` : ".")
  );
}

function describeCard(threadId: string, status: CardStatus): string {
  const lines = status.card ? [renderCard(status.card, Date.now())] : [`No card for ${threadId} yet.`];
  if (status.attempt && !status.attempt.ok) {
    lines.push(`Last build failed at ${new Date(status.attempt.at).toISOString()}: ${status.attempt.error ?? "no detail"}`);
  }
  if (status.building) lines.push("A build is running.");
  else if (status.queued) lines.push("A build is queued.");
  return lines.join("\n");
}

/** `--project <id>` and `--day today|YYYY-MM-DD`; null for anything else. */
function cardsFilter(args: string[]): { projectId?: string; day?: string } | null {
  const filter: { projectId?: string; day?: string } = {};
  for (let index = 0; index < args.length; index += 2) {
    const [name, value] = [args[index], args[index + 1]];
    if (value === undefined) return null;
    if (name === "--project") filter.projectId = value;
    else if (name === "--day" && value === "today") filter.day = bangkokNow(Date.now()).day;
    else if (name === "--day" && /^\d{4}-\d{2}-\d{2}$/.test(value)) filter.day = value;
    else return null;
  }
  return filter;
}

/** The banner footer's shape: the call's cost with a token total. */
function bannerStats(stats: CallStats): FollowupStats {
  const parts = [stats.inputTokens, stats.cachedInputTokens, stats.outputTokens];
  return {
    ms: stats.ms,
    model: stats.model,
    ...(parts.some((value) => value !== undefined)
      ? { totalTokens: parts.reduce<number>((sum, value) => sum + (value ?? 0), 0) }
      : {}),
    ...(stats.inputTokens !== undefined ? { inputTokens: stats.inputTokens } : {}),
    ...(stats.cachedInputTokens !== undefined ? { cachedInputTokens: stats.cachedInputTokens } : {}),
    ...(stats.outputTokens !== undefined ? { outputTokens: stats.outputTokens } : {}),
    ...(stats.reasoningOutputTokens !== undefined ? { reasoningOutputTokens: stats.reasoningOutputTokens } : {}),
  };
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  const settingsHandle = bb.settings.define({
    model: {
      type: "string",
      label: "Model",
      description: "Model for every call. gpt-* uses codex exec on your ChatGPT login. claude-* and haiku, sonnet, opus use your Claude login.",
      default: DEFAULT_MODEL,
    },
    effort: {
      type: "select",
      label: "Effort",
      description: "Thinking effort for every call. max is slowest and best.",
      options: [...EFFORTS],
      default: DEFAULT_EFFORT,
    },
    card: {
      type: "boolean",
      label: "Thread cards",
      description:
        "Build a short card per thread you write in (its task, project, related goals and earlier decisions) in the background, and use it in suggestions. Other plugins can read it.",
      default: true,
    },
    cardRuns: {
      type: "number",
      label: "Card runs at once",
      description: "How many thread cards may be built at the same time (1 to 3).",
      default: DEFAULT_CARD_RUNS,
    },
  });
  type SettingValues = { model?: unknown; effort?: unknown; card?: unknown; cardRuns?: unknown };
  type ChoiceState = { readonly ok: true; readonly choice: ModelChoice } | { readonly ok: false; readonly error: ModelCallError };
  const readChoice = (values: SettingValues): ChoiceState => {
    try {
      return { ok: true, choice: readModelChoice(values) };
    } catch (error) {
      if (!(error instanceof ModelCallError)) throw error;
      bb.log.warn(`followups model setting: ${error.message}`);
      return { ok: false, error };
    }
  };
  const readCards = (values: SettingValues) => ({
    enabled: values.card !== false,
    runs: typeof values.cardRuns === "number" && Number.isFinite(values.cardRuns) ? values.cardRuns : DEFAULT_CARD_RUNS,
  });
  const initialSettings = await settingsHandle.get();
  let choiceState = readChoice(initialSettings);
  const getChoice = (): ModelChoice => {
    if (!choiceState.ok) throw choiceState.error;
    return choiceState.choice;
  };
  let cardSettings = readCards(initialSettings);
  settingsHandle.onChange((next) => {
    choiceState = readChoice(next as SettingValues);
    cardSettings = readCards(next as SettingValues);
  });

  const startOrigins = createStartOriginStore(bb);
  const context = createThreadContextReader(bb, startOrigins);
  // Records how each thread was started (see lib/start-origin.ts). Guarded so a host without
  // hooks loads as before; such a host judges start turns by parent and plugin origin only.
  try {
    bb.experimental_hooks.on("message.dispatch", startOrigins.observe);
  } catch (error) {
    bb.log.warn(`followups cannot see how threads are started: ${errorMessage(error)}`);
  }

  /** Set when the plugin is being reloaded or disabled: nothing new may start, and nothing may log or write. */
  let disposed = false;

  /** Null when the plugin's database can't be opened: follow-ups still work, they just don't learn or log card runs. */
  let db: ReturnType<typeof bb.storage.database> | null = null;
  let learning: Learning | null = null;
  try {
    db = bb.storage.database();
    bb.storage.migrate(db, MIGRATIONS);
    learning = openLearning(db, () => randomUUID());
  } catch (error) {
    db = null;
    bb.log.warn(`followups won't learn from what you pick: its database can't be opened: ${errorMessage(error)}`);
  }
  const cards = createCardService({ bb, db, context, settings: () => cardSettings, choice: getChoice });

  /** The card as the suggestion and draft calls see it; none while cards are off or unreadable. */
  async function cardTextFor(threadId: string): Promise<string | null> {
    if (!cardSettings.enabled) return null;
    try {
      const card = await cards.read(threadId);
      return card ? renderCard(card, Date.now()) : null;
    } catch (error) {
      bb.log.warn(`followups could not read the card of ${threadId}: ${errorMessage(error)}`);
      return null;
    }
  }
  /** Bookkeeping never breaks a suggestion or a draft. */
  function learn(what: string, record: (learning: Learning) => void): void {
    if (!learning || disposed) return;
    try {
      record(learning);
    } catch (error) {
      bb.log.warn(`followups could not record ${what}: ${errorMessage(error)}`);
    }
  }
  /** The owner's recent picks and sends, shown to the model; none when they can't be read. */
  function examplesFor(threadId: string, projectId: string): LearningExample[] {
    if (!learning || disposed) return [];
    try {
      return learning.examples(threadId, projectId);
    } catch (error) {
      bb.log.warn(`followups could not read past picks for ${threadId}: ${errorMessage(error)}`);
      return [];
    }
  }
  /** Threads with a generation currently running, each with that run (see `generate`). */
  const inFlight = new Map<string, Promise<void>>();
  /** Idle events that arrived while a generation was running. */
  const pendingRegen = new Map<string, string | null>();
  /** Monotonic generation per thread; stale calls drop their results. */
  const generations = new Map<string, number>();
  /**
   * One per thread with a suggestion call in flight: aborted when it stops being
   * wanted (the thread moved on, a newer answer is queued, follow-ups were turned
   * off), which kills its model process now instead of letting it run to the end.
   */
  const draftAborts = new Map<string, AbortController>();

  function abortDraft(threadId: string): void {
    draftAborts.get(threadId)?.abort();
  }

  /**
   * The message drafts a click started, per thread (the UI allows one at a time,
   * the RPC and CLI don't). They go when the thread moves on, like the suggestion
   * call, but not when only a newer answer is queued: that doesn't take the
   * follow-up being written away from the user.
   */
  const expandAborts = new Map<string, Set<AbortController>>();

  /** The thread moved on: stop its suggestion call and any message draft in flight. */
  function abortDrafts(threadId: string): void {
    abortDraft(threadId);
    for (const abort of expandAborts.get(threadId) ?? []) abort.abort();
  }

  /** Places left for a suggestion call (see MAX_CONCURRENT_DRAFTS), and the calls waiting for one, oldest first. */
  let freeDraftSlots = MAX_CONCURRENT_DRAFTS;
  const draftQueue: Array<() => void> = [];

  /**
   * Resolves once this call has a place. A call that has moved on by the time its
   * turn comes still gets one, notices it is stale, and hands the place straight on.
   */
  function takeDraftSlot(): Promise<void> {
    if (freeDraftSlots > 0) {
      freeDraftSlots -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => draftQueue.push(resolve));
  }

  /** Hand the place to the next call in line, or keep it free. */
  function giveDraftSlot(): void {
    const next = draftQueue.shift();
    if (next) next();
    else freeDraftSlots += 1;
  }

  function publish(threadId: string): void {
    bb.realtime.publish(FOLLOWUPS_CHANGED, { threadId });
  }

  type BannerState = {
    status: "empty" | "working" | "ready";
    suggestions: FollowupSuggestion[];
    updatedAt: number;
    stats: FollowupStats | null;
    enabled: boolean;
  };

  /** The banner's state, plus what decided `enabled`: the thread's own switch and its turn ledger (null until scanned). */
  async function readState(threadId: string): Promise<BannerState & { override: Override; ledger: TurnLedger | null }> {
    const meta = await bb.sdk.threads.getPluginMetadata({ threadId });
    // The thread's own choice and its ledger are read apart from the rest, so stored
    // follow-ups that can't be read never turn a thread the user switched off back on.
    const record = (meta ?? {}) as Record<string, unknown>;
    const stored = z.enum(["on", "off"]).safeParse(record[META_OVERRIDE]);
    const override: Override = stored.success ? stored.data : null;
    const turns = ledgerSchema.safeParse(record[META_TURNS]);
    const ledger = turns.success ? turns.data : null;
    const threadEnabled = wantsFollowups(override, ledger);
    const decided = { override, ledger };
    const parsed = z
      .object({
        [META_SUGGESTIONS]: z.array(suggestionSchema).optional(),
        [META_STATUS]: z.enum(["empty", "working", "ready"]).optional(),
        [META_UPDATED_AT]: z.number().optional(),
        [META_STATS]: statsSchema.nullable().optional(),
      })
      .safeParse(meta);
    if (!parsed.success) return { status: "empty", suggestions: [], updatedAt: 0, stats: null, enabled: threadEnabled, ...decided };
    const updatedAt = parsed.data[META_UPDATED_AT] ?? 0;
    const status = parsed.data[META_STATUS] ?? "empty";
    if (status === "working" && Date.now() - updatedAt > WORKING_STALE_MS) {
      return { status: "empty", suggestions: [], updatedAt, stats: null, enabled: threadEnabled, ...decided };
    }
    return {
      status,
      suggestions: parsed.data[META_SUGGESTIONS] ?? [],
      updatedAt,
      stats: parsed.data[META_STATS] ?? null,
      enabled: threadEnabled,
      ...decided,
    };
  }

  function bannerState(state: BannerState): BannerState {
    const { status, suggestions, updatedAt, stats, enabled } = state;
    return { status, suggestions, updatedAt, stats, enabled };
  }

  /** Why a thread gets no follow-ups, for the commands that refuse or report it. */
  function offReason(state: { override: Override; ledger: TurnLedger | null }): string {
    if (state.override === "off") return "turned off";
    return state.ledger === null ? "off until its turns can be read" : "off because only agents have written in it";
  }

  /** Read the thread's new turns into its ledger. A failed read leaves the stored ledger to decide. */
  async function scanTurns(threadId: string): Promise<void> {
    try {
      const { newOwnerTurns } = await context.scan(threadId);
      for (const turn of newOwnerTurns) learn("what the owner sent", (from) => from.ownerSent(threadId, turn.text, turn.at));
      if (newOwnerTurns.length > 0 && !disposed) cards.consider(threadId, "owner-turn");
    } catch (error) {
      if (!disposed) bb.log.warn(`followups could not read who wrote in ${threadId}: ${errorMessage(error)}`);
    }
  }

  /** Threads scanned since this process started; the first look at any other one scans it first. */
  const scannedThreads = new Set<string>();
  async function scanOnFirstLook(threadId: string): Promise<void> {
    if (scannedThreads.has(threadId)) return;
    scannedThreads.add(threadId);
    await scanTurns(threadId);
  }

  /**
   * Whether to draft for this thread, after reading its newest turns. If its
   * choice can't be read, don't: a call costs real tokens, and the thread may be
   * one the user switched off or only agents use.
   */
  async function followupsWanted(threadId: string): Promise<boolean> {
    scannedThreads.add(threadId);
    await scanTurns(threadId);
    try {
      return (await readState(threadId)).enabled;
    } catch (error) {
      bb.log.warn(`followups could not read whether ${threadId} is switched on, so it gets none: ${errorMessage(error)}`);
      return false;
    }
  }

  async function writeState(
    threadId: string,
    state: {
      status: "empty" | "working" | "ready";
      suggestions: FollowupSuggestion[];
      stats?: FollowupStats;
    },
  ): Promise<void> {
    await bb.sdk.threads.updatePluginMetadata({
      threadId,
      set: {
        [META_SUGGESTIONS]: state.suggestions,
        [META_STATUS]: state.status,
        [META_STATS]: state.stats ?? null,
        [META_UPDATED_AT]: Date.now(),
      },
    });
    publish(threadId);
  }

  /** Clear the banner: a user-sent message makes old follow-ups stale. */
  async function clearFollowups(threadId: string, reason = "cleared"): Promise<void> {
    // Whatever is being drafted is for the answer being cleared: tell it first,
    // before the state is read, so its call is stopped as early as possible.
    generations.set(threadId, (generations.get(threadId) ?? 0) + 1);
    abortDrafts(threadId);
    // Every thread in BB goes through here whenever it starts a turn or gets a
    // message, almost always with nothing showing: then there is nothing to write
    // and nobody to tell. (If the state can't be read, try the write anyway.)
    const showing = await readState(threadId).then(
      (state) => state.status !== "empty",
      () => true,
    );
    if (!showing) return;
    try {
      await bb.sdk.threads.updatePluginMetadata({
        threadId,
        set: {
          [META_SUGGESTIONS]: [],
          [META_STATUS]: "empty",
          [META_STATS]: null,
          [META_UPDATED_AT]: Date.now(),
        },
      });
    } catch (error) {
      bb.log.warn(`followups clear failed for ${threadId}: ${errorMessage(error)}`);
      return;
    }
    bb.log.info(`followups cleared for ${threadId} (${reason})`);
    publish(threadId);
  }

  /** Wall-clock laps of one run, so a slow one shows which phase was slow. */
  function stopwatch() {
    const startedAt = Date.now();
    let last = startedAt;
    const laps: Record<string, number> = {};
    return {
      lap(name: string): void {
        const now = Date.now();
        laps[name] = now - last;
        last = now;
      },
      describe(): string {
        const parts = Object.entries(laps).map(([name, ms]) => `${name} ${ms}ms`);
        return `${Date.now() - startedAt}ms [${parts.join(", ")}]`;
      },
    };
  }
  /** The latest timing line per run kind and thread, for the diagnostic commands. */
  const lastRuns = new Map<string, string>();

  /** Parents that went idle while their children were still working, and are waiting for them to finish. */
  const waitingOnChildren = new Set<string>();
  const settleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * The child threads, and theirs, that are still working. Hidden children count
   * (agent teams use them); archived ones are finished work and are left out by
   * the default list. If they can't be looked up, nothing is held back: losing
   * follow-ups is worse than showing them a little early.
   */
  async function activeDescendants(threadId: string): Promise<string[]> {
    try {
      const seen = new Set([threadId]);
      let level = [threadId];
      let lookups = 0;
      for (let depth = 0; depth < DESCENDANT_DEPTH && level.length > 0; depth++) {
        const busy: string[] = [];
        const next: string[] = [];
        for (const parentId of level) {
          if (lookups >= DESCENDANT_LOOKUPS) return busy;
          lookups += 1;
          const children = await bb.sdk.threads.list({ parentThreadId: parentId, includeHidden: true, limit: 100 });
          for (const child of children) {
            if (seen.has(child.id)) continue;
            seen.add(child.id);
            if (BUSY_STATUSES.has(child.status)) busy.push(child.id);
            next.push(child.id);
          }
        }
        if (busy.length > 0) return busy;
        level = next;
      }
      return [];
    } catch (error) {
      bb.log.warn(`followups could not look up the child threads of ${threadId}: ${errorMessage(error)}`);
      return [];
    }
  }

  /**
   * A thread stopped working. If one of its ancestors was waiting on its children,
   * check again shortly: that ancestor is normally woken by the child's report and
   * drafts when its own turn ends, so the short wait avoids drafting for an answer
   * it is about to replace.
   */
  async function childSettled(thread: { parentThreadId: string | null }): Promise<void> {
    if (waitingOnChildren.size === 0) return;
    let parentId = thread.parentThreadId;
    for (let depth = 0; parentId !== null && depth <= DESCENDANT_DEPTH; depth++) {
      if (waitingOnChildren.has(parentId)) {
        clearTimeout(settleTimers.get(parentId));
        const waiting = parentId;
        settleTimers.set(waiting, setTimeout(() => void settleWaiting(waiting), CHILD_SETTLE_MS));
      }
      const parent = await bb.sdk.threads.get({ threadId: parentId }).catch(() => null);
      parentId = parent?.parentThreadId ?? null;
    }
  }

  /** The settle time is up: draft for a waiting parent if it is idle and none of its children are working. */
  async function settleWaiting(threadId: string): Promise<void> {
    settleTimers.delete(threadId);
    if (!waitingOnChildren.has(threadId)) return;
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.status !== "idle" || thread.visibility === "hidden") {
        waitingOnChildren.delete(threadId); // it is working again: its own idle event will come
        return;
      }
      if ((await activeDescendants(threadId)).length > 0) return; // another child is still going
      waitingOnChildren.delete(threadId);
      const answer = (await bb.sdk.threads.output({ threadId })).output ?? "";
      bb.log.info(`followups: the children of ${threadId} finished; drafting its follow-ups now`);
      await generate(threadId, answer);
    } catch (error) {
      bb.log.warn(`followups could not draft for ${threadId} after its children finished: ${errorMessage(error)}`);
    }
  }

  type LegacyCleanup = { deleted: string[]; skipped: { id: string; reason: string }[] };

  /**
   * Delete the hidden worker threads earlier releases spawned: ours (by origin),
   * hidden, titled like a worker, and finished. A worker shares its parent's
   * environment, and BB tears an environment down when its last thread is deleted,
   * so a worker whose environment has no other live thread is left alone.
   */
  async function cleanupLegacyWorkers(dryRun: boolean): Promise<LegacyCleanup> {
    const report: LegacyCleanup = { deleted: [], skipped: [] };
    const rows = new Map<string, Awaited<ReturnType<typeof bb.sdk.threads.list>>[number]>();
    for (const archived of [true, false]) {
      for (let offset = 0; offset < LEGACY_SCAN_LIMIT; offset += LEGACY_PAGE) {
        const page = await bb.sdk.threads.list({ originPluginId: bb.pluginId, includeHidden: true, archived, limit: LEGACY_PAGE, offset });
        for (const row of page) rows.set(row.id, row);
        if (page.length < LEGACY_PAGE) break;
      }
    }
    const environmentAlive = new Map<string, boolean>();
    for (const worker of rows.values()) {
      const skip = (reason: string) => report.skipped.push({ id: worker.id, reason });
      if (worker.visibility !== "hidden" || !LEGACY_WORKER_TITLES.has(worker.title ?? "")) {
        skip("not a hidden follow-up worker");
        continue;
      }
      if (worker.status !== "idle" && worker.status !== "error") {
        skip(`still ${worker.status}`);
        continue;
      }
      if (worker.environmentId !== null) {
        let alive = environmentAlive.get(worker.environmentId);
        if (alive === undefined) {
          alive = (await bb.sdk.threads.list({ environmentId: worker.environmentId, limit: 1 })).length > 0;
          environmentAlive.set(worker.environmentId, alive);
        }
        if (!alive) {
          skip("its environment has no other live thread");
          continue;
        }
      }
      if (dryRun) {
        report.deleted.push(worker.id);
        continue;
      }
      let operation = "archive";
      try {
        if (worker.archivedAt === null) await bb.sdk.threads.archive({ threadId: worker.id });
        operation = "delete";
        await bb.sdk.threads.delete({ threadId: worker.id, childThreadsConfirmed: false });
        report.deleted.push(worker.id);
      } catch (error) {
        skip(`${operation} failed: ${errorMessage(error)}`);
      }
    }
    return report;
  }

  /** How a call in flight learns it is no longer wanted. */
  type DraftCancel = { signal: AbortSignal; isStale: () => boolean };

  /**
   * Draft follow-ups for a thread's answer. Settles once the newest answer queued
   * for the thread has been drafted, so a caller that queues behind a call in
   * flight (`bb followups regenerate`) waits for its own run, not just the old one.
   */
  function generate(threadId: string, lastAssistantText: string | null): Promise<void> {
    const running = inFlight.get(threadId);
    if (running) {
      // A newer answer is waiting behind the one being drafted: stop that call
      // rather than make this one wait for it.
      pendingRegen.set(threadId, lastAssistantText);
      abortDraft(threadId);
      return running;
    }
    pendingRegen.delete(threadId); // nothing is running, so anything queued is left over
    const run = (async () => {
      try {
        let answer = lastAssistantText;
        for (;;) {
          await generateOnce(threadId, answer);
          if (disposed || !pendingRegen.has(threadId)) return;
          answer = pendingRegen.get(threadId) ?? null;
          pendingRegen.delete(threadId);
        }
      } finally {
        inFlight.delete(threadId);
      }
    })();
    inFlight.set(threadId, run);
    return run;
  }

  async function generateOnce(threadId: string, lastAssistantText: string | null): Promise<void> {
    if (disposed) return;
    const gen = (generations.get(threadId) ?? 0) + 1;
    generations.set(threadId, gen);
    if (!lastAssistantText || lastAssistantText.trim() === "") return;
    const startedAt = Date.now();
    const clock = stopwatch();

    try {
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.visibility === "hidden") return;
      // The thread's own choice, else whether the owner has written in it.
      if (!(await followupsWanted(threadId))) return;
      // Follow-ups are for a finished answer. A thread that is running again has
      // nothing to suggest yet, and nothing would clear them: BB only signals
      // "became active" on the idle → active transition.
      if (thread.status !== "idle") return;
      // Idle isn't finished while child threads are still working: the thread is
      // waiting on them. Wait too; their last report wakes it, or settleWaiting
      // drafts once they are all done.
      const working = await activeDescendants(threadId);
      if (working.length > 0) {
        waitingOnChildren.add(threadId);
        bb.log.info(`followups: ${threadId} is idle but ${working.length} child thread(s) are still running; waiting for them`);
        return;
      }
      waitingOnChildren.delete(threadId);
      clock.lap("thread");
    } catch (error) {
      if (!disposed) bb.log.warn(`followups could not look up ${threadId}: ${errorMessage(error)}`);
      return;
    }
    if (disposed) return;

    // From here on, anything that clears the thread, queues a newer answer or
    // switches follow-ups off aborts this call (see abortDraft).
    const abort = new AbortController();
    draftAborts.set(threadId, abort);
    const cancel: DraftCancel = {
      signal: abort.signal,
      isStale: () => disposed || abort.signal.aborted || generations.get(threadId) !== gen || pendingRegen.has(threadId),
    };
    /** Leave the banner empty: for a call that ends with nothing to show and nobody left to clear its "working". */
    const leaveEmpty = async (): Promise<void> => {
      if (!disposed) await writeState(threadId, { status: "empty", suggestions: [] }).catch(() => undefined);
    };
    /**
     * This call is no longer wanted. A clear has already emptied the banner,
     * but if only a newer run is queued, or the clear came before this run wrote
     * "working", that state would be left behind with nobody to finish it.
     */
    const dropStale = async (): Promise<void> => {
      if (disposed) return;
      await leaveEmpty();
      bb.log.info(
        `followups: stopped the call for ${threadId} after ${Date.now() - startedAt}ms ` +
          `(${generations.get(threadId) !== gen ? "its thread moved on" : "a newer answer is waiting"})`,
      );
    };

    let holdsSlot = false;
    try {
      // Wait for a free place before showing "finding follow-ups…": a call that is
      // waiting isn't working yet, and the banner stays as it was until it is.
      if (freeDraftSlots === 0) {
        bb.log.info(`followups: ${threadId} is waiting for a free slot (${MAX_CONCURRENT_DRAFTS} calls are running)`);
      }
      await takeDraftSlot();
      holdsSlot = true;
      if (cancel.isStale()) return; // moved on while waiting: nothing was shown yet
      clock.lap("queue");

      await writeState(threadId, { status: "working", suggestions: [] }).catch(() => undefined);
      clock.lap("state");

      const [ctx, cardText] = await Promise.all([context.read(threadId), cardTextFor(threadId)]);
      clock.lap("context");
      if (cancel.isStale()) {
        await dropStale();
        return;
      }
      // BB reports a thread's last message as its "answer", and that is the request
      // itself when the thread went idle before it replied (it was stopped, say).
      if (ctx.latestRequest === lastAssistantText.trim()) {
        await leaveEmpty();
        bb.log.info(`followups: ${threadId} went idle with no assistant answer (its last message is the request itself); no follow-ups`);
        return;
      }
      const hasOpenQuestions = openQuestions(lastAssistantText);
      const { value, stats } = await callModel(
        suggestCall({
          ctx,
          cardText,
          answer: lastAssistantText,
          hasOpenQuestions,
          examples: examplesFor(threadId, ctx.thread.projectId),
          choice: getChoice(),
          signal: abort.signal,
        }),
      );
      clock.lap("model");
      if (cancel.isStale()) {
        await dropStale();
        return;
      }
      if (value.cardStale && cardText !== null) {
        bb.log.info(`followups: the card of ${threadId} looks stale (${value.staleReason ?? "no reason given"})`);
        cards.consider(threadId, "stale");
      }
      const suggestions: FollowupSuggestion[] = pickThree(value.candidates, hasOpenQuestions).map((candidate) => ({
        id: randomUUID().slice(0, 8),
        label: candidate.label,
        kind: candidate.kind,
        why: candidate.why,
      }));
      if (suggestions.length === 0) {
        bb.log.info(`followups: ${threadId} got no suggestions from ${stats.model} in ${Date.now() - startedAt}ms`);
        await leaveEmpty();
        return;
      }
      const timing = clock.describe();
      lastRuns.set(`suggest:${threadId}`, timing);
      // A child may have started working while this was being drafted.
      if ((await activeDescendants(threadId)).length > 0) {
        waitingOnChildren.add(threadId);
        bb.log.info(`followups: a child of ${threadId} started working while its follow-ups were drafted; holding them back`);
        await leaveEmpty();
        return;
      }
      // Switched off, or a newer run started, while the children were looked up.
      if (generations.get(threadId) !== gen) return;
      bb.log.info(
        `followups ready for ${threadId}: ${suggestions.length} suggestions in ${timing}, ` +
          `${stats.inputTokens ?? "?"} input + ${stats.cachedInputTokens ?? "?"} cached + ${stats.outputTokens ?? "?"} output tokens (${stats.model})`,
      );
      await writeState(threadId, { status: "ready", suggestions, stats: bannerStats(stats) }).catch(() => undefined);
      learn("the shown follow-ups", (from) => from.shown(threadId, ctx.thread.projectId, suggestions));
    } catch (error) {
      if (disposed) return;
      if (cancel.isStale()) {
        await dropStale();
        return;
      }
      bb.log.warn(`followups generate failed for ${threadId}: ${errorMessage(error)}`);
      if (generations.get(threadId) === gen) await leaveEmpty();
    } finally {
      if (holdsSlot) giveDraftSlot();
      if (draftAborts.get(threadId) === abort) draftAborts.delete(threadId);
    }
  }

  /**
   * Write the full message for a follow-up the user picked. If the thread moves
   * on meanwhile (it goes active, a message is sent, the banner is dismissed or
   * turned off) the draft is no longer wanted: its call is killed at once and
   * this rejects, so a stale draft can never reach the composer.
   */
  async function expandFollowup(
    threadId: string,
    id: string,
  ): Promise<{ text: string; drafted: boolean; stats: FollowupStats | null }> {
    const abort = new AbortController();
    const aborts = expandAborts.get(threadId) ?? new Set<AbortController>();
    aborts.add(abort);
    expandAborts.set(threadId, aborts);
    try {
      return await runExpansion(threadId, id, { signal: abort.signal, isStale: () => disposed || abort.signal.aborted });
    } finally {
      aborts.delete(abort);
      if (aborts.size === 0 && expandAborts.get(threadId) === aborts) expandAborts.delete(threadId);
    }
  }

  async function runExpansion(
    threadId: string,
    id: string,
    cancel: DraftCancel,
  ): Promise<{ text: string; drafted: boolean; stats: FollowupStats | null }> {
    const startedAt = Date.now();
    const clock = stopwatch();
    const gone = () => new Error("That follow-up is no longer available.");
    const state = await readState(threadId);
    const picked = state.suggestions.find((item) => item.id === id);
    if (!picked || cancel.isStale()) throw gone();
    let answer = "";
    try {
      answer = (await bb.sdk.threads.output({ threadId })).output ?? "";
    } catch {
      answer = "";
    }
    clock.lap("answer");
    if (cancel.isStale()) throw gone();
    try {
      const [ctx, cardText] = await Promise.all([context.read(threadId), cardTextFor(threadId)]);
      clock.lap("context");
      if (cancel.isStale()) throw gone(); // before a call is started for it
      const { value, stats } = await callModel(
        draftCall({
          ctx,
          cardText,
          answer,
          hasOpenQuestions: openQuestions(answer),
          examples: examplesFor(threadId, ctx.thread.projectId),
          choice: getChoice(),
          signal: cancel.signal,
          picked: { label: picked.label, kind: picked.kind ?? null, why: picked.why ?? null },
        }),
      );
      clock.lap("model");
      if (cancel.isStale()) throw gone(); // finished, but for a thread that has moved on
      const text = cleanDraft(value.message);
      lastRuns.set(`draft:${threadId}`, clock.describe());
      bb.log.info(`followups drafted for ${threadId} in ${clock.describe()}`);
      return text === ""
        ? { text: picked.label, drafted: false, stats: bannerStats(stats) }
        : { text, drafted: true, stats: bannerStats(stats) };
    } catch (error) {
      if (cancel.isStale()) {
        if (!disposed) bb.log.info(`followups: stopped the message draft for ${threadId} after ${Date.now() - startedAt}ms (its thread moved on)`);
        throw gone();
      }
      bb.log.warn(`followups expand failed for ${threadId}: ${errorMessage(error)}`);
      return { text: picked.label, drafted: false, stats: null };
    }
  }

  /**
   * Switch follow-ups on or off for one thread. Off clears what it shows and
   * drops any call in flight (clearing bumps the thread's generation); on drafts
   * from the latest answer if the thread is finished and has none showing, and
   * otherwise waits for its next idle.
   */
  async function setThreadEnabled(threadId: string, on: boolean): Promise<{ enabled: boolean }> {
    await bb.sdk.threads.updatePluginMetadata({ threadId, set: { [META_OVERRIDE]: on ? "on" : "off" } });
    bb.log.info(`followups turned ${on ? "on" : "off"} for ${threadId}`);
    if (!on) {
      pendingRegen.delete(threadId);
      waitingOnChildren.delete(threadId);
      clearTimeout(settleTimers.get(threadId));
      settleTimers.delete(threadId);
      await clearFollowups(threadId, "turned off for this thread");
      return { enabled: false };
    }
    publish(threadId);
    void draftFromLatestAnswer(threadId).catch((error: unknown) => {
      bb.log.warn(`followups could not draft for ${threadId} after it was turned on: ${errorMessage(error)}`);
    });
    return { enabled: true };
  }

  async function draftFromLatestAnswer(threadId: string): Promise<void> {
    if ((await readState(threadId)).status !== "empty") return;
    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.visibility === "hidden" || thread.status !== "idle") return;
    const answer = (await bb.sdk.threads.output({ threadId })).output ?? "";
    await generate(threadId, answer);
  }

  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    // Hidden threads (other plugins' helpers, agent teams) never get follow-ups.
    if (thread.visibility === "hidden") return;
    void generate(thread.id, lastAssistantText).catch((error: unknown) => {
      bb.log.warn(`followups idle handler failed: ${errorMessage(error)}`);
    });
  });

  // A message the user sends (queued, dispatched, thread back to work) clears
  // the banner: the follow-ups belonged to the previous answer.
  bb.events.on("message.queued", ({ entry }) => {
    void clearFollowups(entry.threadId, "message queued").catch(() => undefined);
  });
  bb.events.on("message.dispatched", ({ entry }) => {
    void clearFollowups(entry.threadId, "message dispatched").catch(() => undefined);
  });
  bb.events.on("thread.active", ({ thread }) => {
    if (thread.visibility === "hidden") return;
    waitingOnChildren.delete(thread.id); // working again: its next idle event decides
    void clearFollowups(thread.id, "thread active").catch(() => undefined);
    // The turn that woke it is already requested: learn who wrote it.
    scannedThreads.add(thread.id);
    void scanTurns(thread.id);
  });
  // A child (or deeper) stopped working: a parent that was waiting on its children may be able to draft now.
  for (const event of ["thread.idle", "thread.failed", "thread.archived", "thread.deleted"] as const) {
    bb.events.on(event, ({ thread }) => {
      void childSettled(thread).catch((error: unknown) => {
        bb.log.warn(`followups child handler failed: ${errorMessage(error)}`);
      });
    });
  }
  for (const event of ["thread.deleted", "thread.archived"] as const) {
    bb.events.on(event, ({ thread }) => {
      inFlight.delete(thread.id);
      pendingRegen.delete(thread.id);
      generations.delete(thread.id);
      abortDrafts(thread.id);
      draftAborts.delete(thread.id);
      expandAborts.delete(thread.id);
      waitingOnChildren.delete(thread.id);
      clearTimeout(settleTimers.get(thread.id));
      settleTimers.delete(thread.id);
      scannedThreads.delete(thread.id);
      cards.forget(thread.id);
    });
  }

  // Every agent session lists the skill that tells it how to inspect the banner.
  // Guarded so a host without this hook just loads as before.
  try {
    bb.agents.configure(() => ({ tools: [], skills: ["followups"] }));
  } catch (error) {
    bb.log.warn(`followups agent configuration unavailable: ${errorMessage(error)}`);
  }

  bb.rpc.register(rpcContract, {
    followups_get: async ({ threadId }) => {
      await scanOnFirstLook(threadId);
      return bannerState(await readState(threadId));
    },
    followups_set_enabled: ({ threadId, enabled: on }) => setThreadEnabled(threadId, on),
    followups_expand: async ({ threadId, id }) => {
      const result = await expandFollowup(threadId, id);
      // Only the banner's click counts as his pick; `bb followups draft` is a diagnostic.
      learn("the picked follow-up", (from) => from.drafted(threadId, id, result.text));
      return result;
    },
    followups_dismiss: async ({ threadId }) => {
      learn("the dismissal", (from) => from.dismissed(threadId));
      await clearFollowups(threadId, "dismissed");
      return { dismissed: true as const };
    },
  });

  const usage = [
    "Usage:",
    "  bb followups show <thread-id> [--json]",
    "  bb followups clear <thread-id> [--json]",
    "  bb followups on <thread-id> [--json]",
    "  bb followups off <thread-id> [--json]",
    "  bb followups model [--json]",
    "  bb followups model-clear [--json]",
    "  bb followups cleanup [--dry-run] [--json]",
    "  bb followups regenerate <thread-id> [--json]",
    "  bb followups draft <thread-id> <suggestion-id> [--json]",
    "  bb followups stats [--days <n>] [--project <project-id>] [--json]",
    "  bb followups card <thread-id> [--refresh] [--json]",
    "  bb followups cards [--project <project-id>] [--day today|YYYY-MM-DD] [--json]",
  ].join("\n");
  bb.cli.register({
    name: "followups",
    summary: "Inspect the follow-up prompts suggested for a thread",
    commands: [
      { name: "show", summary: "Show suggested follow-ups", usage: "bb followups show <thread-id> [--json]" },
      { name: "clear", summary: "Clear suggested follow-ups", usage: "bb followups clear <thread-id> [--json]" },
      { name: "on", summary: "Turn follow-ups on for one thread", usage: "bb followups on <thread-id> [--json]" },
      { name: "off", summary: "Turn follow-ups off for one thread", usage: "bb followups off <thread-id> [--json]" },
      { name: "model", summary: "Show the model and effort every call uses", usage: "bb followups model [--json]" },
      { name: "model-clear", summary: "Reset the model and effort to their defaults", usage: "bb followups model-clear [--json]" },
      { name: "cleanup", summary: "Delete the hidden worker threads earlier releases left behind", usage: "bb followups cleanup [--dry-run] [--json]" },
      { name: "regenerate", summary: "Draft a thread's follow-ups again now, and show where the time went", usage: "bb followups regenerate <thread-id> [--json]" },
      { name: "draft", summary: "Run the draft step for a suggestion, and show where the time went", usage: "bb followups draft <thread-id> <suggestion-id> [--json]" },
      { name: "stats", summary: "How often the owner sent a suggested follow-up, by kind, and what thread cards cost", usage: "bb followups stats [--days <n>] [--project <project-id>] [--json]" },
      { name: "card", summary: "Show a thread's card, or build it now with --refresh", usage: "bb followups card <thread-id> [--refresh] [--json]" },
      { name: "cards", summary: "List thread cards, newest first", usage: "bb followups cards [--project <project-id>] [--day today|YYYY-MM-DD] [--json]" },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const [command, ...args] = argv.filter((arg) => arg !== "--json");
      const reply = (value: unknown, text: string) => ({
        exitCode: 0,
        stdout: json ? `${JSON.stringify(value, null, 2)}\n` : `${text}\n`,
      });
      switch (command) {
        case undefined:
        case "help":
        case "--help":
          return { exitCode: 0, stdout: `${usage}\n` };
        case "show": {
          const threadId = args[0];
          if (!threadId || args.length !== 1) break;
          await scanOnFirstLook(threadId);
          const state = await readState(threadId);
          const text = !state.enabled
            ? `Follow-ups are ${offReason(state)} for ${threadId}.`
            : state.suggestions.length === 0
              ? `No follow-ups for ${threadId} (${state.status}).`
              : [
                  ...state.suggestions.map(
                    (item) => `• ${item.kind ? `[${item.kind}] ` : ""}${item.label}  [${item.id}]` + (item.why ? `\n    why: ${item.why}` : ""),
                  ),
                  ...(state.stats ? [`Generated in ${(state.stats.ms / 1000).toFixed(1)}s` +
                    (state.stats.totalTokens !== undefined
                      ? `, ${state.stats.totalTokens.toLocaleString("en-US")} tokens` +
                        ` (${(state.stats.cachedInputTokens ?? 0).toLocaleString("en-US")} cached, ` +
                        `${(state.stats.outputTokens ?? 0).toLocaleString("en-US")} output)`
                      : "") +
                    ` by ${state.stats.model}`] : []),
                ].join("\n");
          return reply({ threadId, ...bannerState(state) }, text);
        }
        case "clear": {
          const threadId = args[0];
          if (!threadId || args.length !== 1) break;
          await clearFollowups(threadId);
          return reply({ threadId, cleared: true }, `Cleared follow-ups for ${threadId}.`);
        }
        case "on":
        case "off": {
          const threadId = args[0];
          if (!threadId || args.length !== 1) break;
          const on = command === "on";
          await setThreadEnabled(threadId, on);
          return reply(
            { threadId, enabled: on },
            on
              ? `Follow-ups are on for ${threadId}; they are drafted now if it has finished, else when it does.`
              : `Follow-ups are off for ${threadId}.`,
          );
        }
        case "model": {
          if (args.length !== 0) break;
          const choice = getChoice();
          return reply(
            { model: choice.model, effort: choice.effort, provider: choice.provider },
            describeModel(choice),
          );
        }
        case "model-clear": {
          if (args.length !== 0) break;
          choiceState = readChoice(await settingsHandle.experimental_set({ model: null, effort: null }));
          const choice = getChoice();
          return reply(
            { model: choice.model, effort: choice.effort, provider: choice.provider },
            `Model reset to ${choice.model} at ${choice.effort} effort.`,
          );
        }
        case "regenerate": {
          const threadId = args[0];
          if (!threadId || args.length !== 1) break;
          if (!(await followupsWanted(threadId))) {
            return {
              exitCode: 1,
              stderr: `Follow-ups are ${offReason(await readState(threadId))} for ${threadId}. Run \`bb followups on ${threadId}\` first.\n`,
            };
          }
          const thread = await bb.sdk.threads.get({ threadId });
          if (thread.status !== "idle") {
            return {
              exitCode: 1,
              stderr: `Thread ${threadId} is ${thread.status}. Follow-ups are only drafted once a thread has finished, so regenerate after it goes idle.\n`,
            };
          }
          const working = await activeDescendants(threadId);
          if (working.length > 0) {
            return {
              exitCode: 1,
              stderr: `Thread ${threadId} is idle but ${working.length} of its child thread(s) are still running, so it isn't finished. Regenerate once they are done.\n`,
            };
          }
          const answer = (await bb.sdk.threads.output({ threadId })).output ?? "";
          if (answer.trim() === "") {
            return { exitCode: 1, stderr: `Thread ${threadId} has no answer to draw follow-ups from.\n` };
          }
          // Only this run's timing is reported: if it draws nothing, there is none.
          lastRuns.delete(`suggest:${threadId}`);
          await generate(threadId, answer);
          const state = bannerState(await readState(threadId));
          const timing = lastRuns.get(`suggest:${threadId}`) ?? null;
          const withReason = state.suggestions.filter((item) => item.why).length;
          return reply(
            { threadId, ...state, timing },
            [
              `${state.suggestions.length} suggestion(s), ${withReason} with a reason (${state.status}).`,
              timing ? `Took ${timing}.` : "No timing recorded (nothing was generated).",
              ...state.suggestions.map(
                (item) => `• ${item.kind ? `[${item.kind}] ` : ""}${item.label}  [${item.id}]` + (item.why ? `\n    why: ${item.why}` : ""),
              ),
            ].join("\n"),
          );
        }
        case "draft": {
          const [threadId, id] = args;
          if (!threadId || !id || args.length !== 2) break;
          const startedAt = Date.now();
          const result = await expandFollowup(threadId, id);
          const elapsed = Date.now() - startedAt;
          const timing = lastRuns.get(`draft:${threadId}`) ?? null;
          return reply(
            { threadId, id, elapsedMs: elapsed, timing, ...result },
            [
              `${result.drafted ? "Drafted" : "Fell back to the short label"} in ${elapsed}ms${timing ? ` (${timing})` : ""}.`,
              "",
              result.text,
            ].join("\n"),
          );
        }
        case "stats": {
          const options = statsOptions(args);
          if (!options) break;
          if (!learning) return { exitCode: 1, stderr: "Follow-up statistics are unavailable: the plugin database can't be opened.\n" };
          const stats = learning.stats(options);
          const cardRuns = cards.runSummary({ days: options.days });
          return reply({ ...stats, cards: cardRuns }, `${describeStats(stats, options.projectId)}\n${describeCardRuns(cardRuns)}`);
        }
        case "card": {
          const refresh = args.includes("--refresh");
          const rest = args.filter((arg) => arg !== "--refresh");
          const threadId = rest[0];
          if (!threadId || rest.length !== 1) break;
          if (refresh && !cardSettings.enabled) {
            return { exitCode: 1, stderr: "Thread cards are turned off in the plugin settings (card).\n" };
          }
          const status = refresh ? await cards.refresh(threadId) : await cards.status(threadId);
          return reply({ threadId, ...status }, describeCard(threadId, status));
        }
        case "cards": {
          const filter = cardsFilter(args);
          if (!filter) break;
          const list = await cards.list(filter);
          return reply(
            list,
            list.length === 0 ? "No thread cards." : list.map((card) => `${card.threadId}  ${card.day}  [${card.role}]  ${card.task}`).join("\n"),
          );
        }
        case "cleanup": {
          if (args.some((arg) => arg !== "--dry-run")) break;
          const dryRun = args.includes("--dry-run");
          const report = await cleanupLegacyWorkers(dryRun);
          const lines = [`${dryRun ? "Would delete" : "Deleted"} ${report.deleted.length} leftover worker thread(s).`];
          const reasons = new Map<string, number>();
          for (const item of report.skipped) reasons.set(item.reason, (reasons.get(item.reason) ?? 0) + 1);
          for (const [reason, count] of reasons) lines.push(`Left alone: ${count} (${reason})`);
          return reply({ dryRun, ...report }, lines.join("\n"));
        }
      }
      return { exitCode: 1, stderr: `${usage}\n` };
    },
  });

  bb.onDispose(() => {
    disposed = true;
    cards.dispose();
    for (const timer of settleTimers.values()) clearTimeout(timer);
    settleTimers.clear();
    // Calls in flight would otherwise carry on against a dead API handle once
    // this returns: kill their model processes now.
    for (const abort of draftAborts.values()) abort.abort();
    for (const aborts of expandAborts.values()) for (const abort of aborts) abort.abort();
    bb.log.info("disposed");
  });
}

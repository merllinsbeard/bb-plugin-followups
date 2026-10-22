// Whose turn it is (R1) and the bb facts that rule reads. A thread's `client/turn/requested`
// events are the only record of who wrote what; `scan` is their only reader and the `turns`
// ledger in thread metadata its only output.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { META_START_ORIGIN, type StartOrigin, type StartOriginStore } from "./start-origin.ts";

export type TurnAuthor = "owner" | "agent" | "system";

/** The authorship fields of one turn request. */
export interface TurnRequest {
  readonly seq: number;
  readonly at: number;
  readonly initiator: "user" | "agent" | "system";
  readonly senderThreadId: string | null;
  readonly source: "spawn" | "tell";
  /** Text parts joined; parts only the agent sees are left out. */
  readonly text: string;
}

const turnRequestEvent = z.object({
  seq: z.number(),
  createdAt: z.number(),
  type: z.literal("client/turn/requested"),
  data: z.object({
    initiator: z.enum(["user", "agent", "system"]),
    senderThreadId: z.string().nullable(),
    source: z.enum(["spawn", "tell"]),
    input: z.array(z.unknown()).default([]),
  }),
});
const textPart = z.object({ type: z.literal("text"), text: z.string(), visibility: z.string().optional() });

export function turnRequestFromEvent(event: unknown): TurnRequest | null {
  const parsed = turnRequestEvent.safeParse(event);
  if (!parsed.success) return null;
  const { seq, createdAt, data } = parsed.data;
  const text = data.input
    .flatMap((part) => {
      const parsed = textPart.safeParse(part);
      return parsed.success && parsed.data.visibility !== "agent-only" ? [parsed.data.text] : [];
    })
    .join("\n");
  return { seq, at: createdAt, initiator: data.initiator, senderThreadId: data.senderThreadId, source: data.source, text };
}

/** The bb facts the rules read about one thread. */
export interface ThreadFacts {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly status: string;
  readonly parentThreadId: string | null;
  readonly originPluginId: string | null;
  readonly sectionId: string | null;
  readonly environmentId: string | null;
  readonly visibility: "visible" | "hidden";
}

export function threadFacts(row: {
  id: string;
  projectId: string;
  title: string | null;
  titleFallback?: string | null;
  status: string;
  parentThreadId: string | null;
  originPluginId: string | null;
  sectionId: string | null;
  environmentId: string | null;
  visibility: string;
}): ThreadFacts {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title ?? row.titleFallback ?? "",
    status: row.status,
    parentThreadId: row.parentThreadId,
    originPluginId: row.originPluginId,
    sectionId: row.sectionId,
    environmentId: row.environmentId,
    visibility: row.visibility === "hidden" ? "hidden" : "visible",
  };
}

/**
 * Live event log, 2026-10-22: an agent's `tell` carries a sender; a child's report is `system`;
 * the owner's follow-up is `user` with no sender. A thread's start turn reads `spawn | user | no
 * sender` both when the owner starts it in the app and when an agent, cron or script runs
 * `bb thread spawn`. Only the dispatch hook's origin tells those apart, so the start turn is
 * judged by it when it was recorded, and by parent or plugin origin for older threads.
 */
export function turnAuthor(
  turn: TurnRequest,
  thread: Pick<ThreadFacts, "parentThreadId" | "originPluginId">,
  startOrigin: StartOrigin,
): TurnAuthor {
  if (turn.initiator === "system") return "system";
  if (turn.initiator === "agent" || turn.senderThreadId !== null) return "agent";
  if (turn.source === "spawn") {
    if (startOrigin !== null) return startOrigin === "app" ? "owner" : "agent";
    return thread.parentThreadId !== null || thread.originPluginId !== null ? "agent" : "owner";
  }
  return "owner";
}

export const META_TURNS = "turns";

/** What `scan` has learned about a thread's turns. Fixed size. (A type alias, so it fits bb's JSON metadata.) */
export type TurnLedger = {
  /** Highest turn-request seq examined. */
  readonly scannedSeq: number;
  readonly lastOwnerSeq: number | null;
  readonly lastOwnerAt: number | null;
};
export const EMPTY_LEDGER: TurnLedger = { scannedSeq: 0, lastOwnerSeq: null, lastOwnerAt: null };

export const ledgerSchema = z.object({
  scannedSeq: z.number(),
  lastOwnerSeq: z.number().nullable(),
  lastOwnerAt: z.number().nullable(),
});

export type Override = "on" | "off" | null;

/** A thread's own switch wins; otherwise it gets follow-ups once the owner has written in it. */
export function wantsFollowups(override: Override, ledger: TurnLedger | null): boolean {
  if (override !== null) return override === "on";
  return ledger?.lastOwnerSeq != null;
}

export type ThreadRole = "orchestrator" | "worker" | "root";

/** The orchestrator title convention ("Оркестратор · <project>"), then parentage. */
export function threadRole(thread: Pick<ThreadFacts, "title" | "parentThreadId">): ThreadRole {
  if (/^Оркестратор\s*·/.test(thread.title)) return "orchestrator";
  return thread.parentThreadId !== null ? "worker" : "root";
}

export interface BangkokNow {
  readonly ms: number;
  /** YYYY-MM-DD in Asia/Bangkok. */
  readonly day: string;
  /** "14:05" */
  readonly time: string;
  /** "среда" */
  readonly weekday: string;
}

const bangkokParts = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Asia/Bangkok",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  weekday: "long",
});

/** The owner's clock: he lives in Asia/Bangkok. */
export function bangkokNow(ms: number): BangkokNow {
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    bangkokParts.formatToParts(ms).find((item) => item.type === type)?.value ?? "";
  return {
    ms,
    day: `${part("year")}-${part("month")}-${part("day")}`,
    time: `${part("hour")}:${part("minute")}`,
    weekday: part("weekday"),
  };
}

export interface SiblingLine {
  readonly threadId: string;
  readonly title: string;
  readonly status: string;
  readonly minutesAgo: number;
  readonly relation: "parent" | "child" | "sibling";
}

/** What both calls get about one thread. */
export interface ThreadContext {
  readonly thread: ThreadFacts;
  readonly role: ThreadRole;
  readonly now: BangkokNow;
  readonly ledger: TurnLedger;
  /** The thread's first request, whoever wrote it: it defines the task. Clipped. */
  readonly firstPrompt: string | null;
  /** The owner's last few prompts, oldest first, clipped. Agent tells never count as his voice. */
  readonly ownerPrompts: readonly OwnerPrompt[];
  /** The newest request of any author, unclipped: bb reports it as the "answer" when no reply came. */
  readonly latestRequest: string | null;
  /** Parent, children, then threads active in the last day beside it; newest first within each. */
  readonly siblings: readonly SiblingLine[];
}

/** One of the owner's prompts, clipped, and the seq of its turn request. */
export type OwnerPrompt = { readonly seq: number; readonly text: string };

export interface ScanResult {
  readonly ledger: TurnLedger;
  /** Owner turns this scan saw for the first time, oldest first. */
  readonly newOwnerTurns: readonly TurnRequest[];
}

export interface ThreadContextReader {
  facts(threadId: string): Promise<ThreadFacts>;
  /**
   * Read the turn requests after the ledger's `scannedSeq`, classify them and store the ledger.
   * Idempotent by seq, and one at a time per thread: a call made while one runs gets a fresh
   * scan after it, so a turn requested meanwhile is never missed.
   */
  scan(threadId: string): Promise<ScanResult>;
  /** Everything the calls are shown. Parts that can't be read are left out and logged. */
  read(threadId: string): Promise<ThreadContext>;
  /** The agent's last message before the event `seq`: what a prompt at `seq` answers. null when there is none. */
  messageBefore(threadId: string, seq: number): Promise<string | null>;
}

const seqOf = z.object({ seq: z.number() });
const agentMessageEvent = z.object({ data: z.object({ item: z.object({ type: z.literal("agentMessage"), text: z.string() }) }) });

/** The latest prompt gets room (the answer responds to it); earlier ones are background. */
const OWNER_PROMPTS = 3;
const LATEST_PROMPT_CHARS = 1_500;
const EARLIER_PROMPT_CHARS = 400;
const FIRST_PROMPT_CHARS = 2_500;
/** Turn requests read for the owner's prompts: enough to reach past a run of agent reports. */
const RECENT_TURNS = 40;
const SIBLINGS = 8;
/** Items read back from a prompt for the message before it: a turn's last item is its message. */
const ITEMS_BEFORE = 20;
const SIBLING_WINDOW_MS = 24 * 60 * 60 * 1000;

function clipEnd(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()} […]`;
}
const PAGE = 100;
/** A long history is read over several scans; each continues where the last stopped. */
const PAGES_PER_SCAN = 20;

export function createThreadContextReader(bb: BbPluginApi, startOrigins: StartOriginStore): ThreadContextReader {
  const running = new Map<string, Promise<ScanResult>>();
  const queued = new Map<string, Promise<ScanResult>>();

  async function facts(threadId: string): Promise<ThreadFacts> {
    return threadFacts(await bb.sdk.threads.get({ threadId }));
  }

  async function scanOnce(threadId: string): Promise<ScanResult> {
    const [meta, thread] = await Promise.all([bb.sdk.threads.getPluginMetadata({ threadId }), facts(threadId)]);
    const record = (meta ?? {}) as Record<string, unknown>;
    const stored = ledgerSchema.safeParse(record[META_TURNS]);
    const startOrigin = startOrigins.originOf(threadId, record[META_START_ORIGIN]);
    let ledger: TurnLedger = stored.success ? stored.data : EMPTY_LEDGER;
    const newOwnerTurns: TurnRequest[] = [];
    for (let page = 0; page < PAGES_PER_SCAN; page++) {
      const rows = await bb.sdk.threads.events.list({
        threadId,
        types: ["client/turn/requested"],
        afterSeq: String(ledger.scannedSeq),
        order: "asc",
        limit: String(PAGE),
      });
      for (const row of rows) {
        const seq = seqOf.safeParse(row);
        if (!seq.success || seq.data.seq <= ledger.scannedSeq) continue;
        ledger = { ...ledger, scannedSeq: seq.data.seq };
        const turn = turnRequestFromEvent(row);
        if (turn && turnAuthor(turn, thread, startOrigin) === "owner") {
          ledger = { ...ledger, lastOwnerSeq: turn.seq, lastOwnerAt: turn.at };
          newOwnerTurns.push(turn);
        }
      }
      if (rows.length < PAGE) break;
    }
    // Written the first time even when there was nothing to read, so the thread counts as scanned.
    if (!stored.success || ledger.scannedSeq !== stored.data.scannedSeq) {
      await bb.sdk.threads.updatePluginMetadata({ threadId, set: { [META_TURNS]: ledger } });
    }
    return { ledger, newOwnerTurns };
  }

  function scan(threadId: string): Promise<ScanResult> {
    const waiting = queued.get(threadId);
    if (waiting) return waiting;
    const start = (): Promise<ScanResult> => {
      queued.delete(threadId);
      const run = scanOnce(threadId).finally(() => {
        if (running.get(threadId) === run) running.delete(threadId);
      });
      running.set(threadId, run);
      return run;
    };
    const current = running.get(threadId);
    if (!current) return start();
    const next = current.then(start, start);
    queued.set(threadId, next);
    return next;
  }

  /** A failed part of the context means less context, never no follow-ups. */
  async function orEmpty<T>(what: string, threadId: string, read: Promise<T>, empty: T): Promise<T> {
    try {
      return await read;
    } catch (error) {
      bb.log.warn(`followups could not read ${what} of ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
      return empty;
    }
  }

  async function siblingsOf(thread: ThreadFacts, now: number): Promise<SiblingLine[]> {
    type Row = { id: string; title: string | null; titleFallback?: string | null; status: string; updatedAt: number };
    const [parent, children, around] = await Promise.all([
      thread.parentThreadId === null ? null : bb.sdk.threads.get({ threadId: thread.parentThreadId }).catch(() => null),
      bb.sdk.threads.list({ parentThreadId: thread.id, includeHidden: true, limit: 20 }),
      // A section groups related work; Personal holds unrelated threads, so the project is the fallback only.
      bb.sdk.threads.list(thread.sectionId !== null ? { sectionId: thread.sectionId, limit: 30 } : { projectId: thread.projectId, limit: 30 }),
    ]);
    const newest = (rows: Row[]) => [...rows].sort((a, b) => b.updatedAt - a.updatedAt);
    const line = (row: Row, relation: SiblingLine["relation"]): SiblingLine => ({
      threadId: row.id,
      title: row.title ?? row.titleFallback ?? "",
      status: row.status,
      minutesAgo: Math.max(0, Math.round((now - row.updatedAt) / 60_000)),
      relation,
    });
    // This plugin's own leftover helper threads are not anyone's work.
    const kids = newest(children.filter((row) => row.originPluginId !== bb.pluginId));
    const near = new Set([thread.id, thread.parentThreadId, ...kids.map((row) => row.id)]);
    const others = newest(around.filter((row) => !near.has(row.id) && now - row.updatedAt <= SIBLING_WINDOW_MS));
    return [
      ...(parent ? [line(parent, "parent")] : []),
      ...kids.map((row) => line(row, "child")),
      ...others.map((row) => line(row, "sibling")),
    ].slice(0, SIBLINGS);
  }

  async function read(threadId: string): Promise<ThreadContext> {
    const now = Date.now();
    const [meta, thread] = await Promise.all([bb.sdk.threads.getPluginMetadata({ threadId }), facts(threadId)]);
    const record = (meta ?? {}) as Record<string, unknown>;
    const stored = ledgerSchema.safeParse(record[META_TURNS]);
    const startOrigin = startOrigins.originOf(threadId, record[META_START_ORIGIN]);
    const types = ["client/turn/requested"] as const;
    const [recent, first, siblings] = await Promise.all([
      orEmpty("the recent turns", threadId, bb.sdk.threads.events.list({ threadId, types, order: "desc", limit: String(RECENT_TURNS) }), []),
      orEmpty("the first turn", threadId, bb.sdk.threads.events.list({ threadId, types, order: "asc", limit: "1" }), []),
      orEmpty("the threads around", threadId, siblingsOf(thread, now), []),
    ]);
    const turns = recent.map(turnRequestFromEvent).filter((turn): turn is TurnRequest => turn !== null);
    const owner = turns
      .filter((turn) => turnAuthor(turn, thread, startOrigin) === "owner" && turn.text.trim() !== "")
      .slice(0, OWNER_PROMPTS)
      .reverse();
    const firstTurn = first.map(turnRequestFromEvent)[0] ?? null;
    return {
      thread,
      role: threadRole(thread),
      now: bangkokNow(now),
      ledger: stored.success ? stored.data : EMPTY_LEDGER,
      firstPrompt: firstTurn && firstTurn.text.trim() !== "" ? clipEnd(firstTurn.text.trim(), FIRST_PROMPT_CHARS) : null,
      ownerPrompts: owner.map((turn, index, all) => ({
        seq: turn.seq,
        text: clipMiddleKeepEnd(turn.text.trim(), index === all.length - 1 ? LATEST_PROMPT_CHARS : EARLIER_PROMPT_CHARS),
      })),
      latestRequest: turns[0]?.text.trim() || null,
      siblings,
    };
  }

  async function messageBefore(threadId: string, seq: number): Promise<string | null> {
    const rows = await bb.sdk.threads.events.list({
      threadId,
      types: ["item/completed"],
      beforeSeq: String(seq),
      order: "desc",
      limit: String(ITEMS_BEFORE),
    });
    for (const row of rows) {
      const message = agentMessageEvent.safeParse(row);
      if (message.success && message.data.data.item.text.trim() !== "") return message.data.data.item.text.trim();
    }
    return null;
  }

  return { facts, scan, read, messageBefore };
}

/** As suggest.ts clips an answer: the start for context, the end kept whole. */
function clipMiddleKeepEnd(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max / 4);
  return `${text.slice(0, head).trimEnd()}\n[…]\n${text.slice(text.length - (max - head)).trimStart()}`;
}

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
  readonly visibility: "visible" | "hidden";
}

export function threadFacts(row: {
  id: string;
  projectId: string;
  title: string | null;
  status: string;
  parentThreadId: string | null;
  originPluginId: string | null;
  sectionId: string | null;
  visibility: string;
}): ThreadFacts {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title ?? "",
    status: row.status,
    parentThreadId: row.parentThreadId,
    originPluginId: row.originPluginId,
    sectionId: row.sectionId,
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
}

const seqOf = z.object({ seq: z.number() });
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

  return { facts, scan };
}

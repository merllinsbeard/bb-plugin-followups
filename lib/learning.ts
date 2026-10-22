// What the owner did with each banner: picked a suggestion and sent it as drafted, edited it,
// wrote his own message instead, or let it go. Kept in the plugin's own SQLite database, so
// the prompts can show his recent choices and `bb followups stats` can count them.

import type Database from "better-sqlite3";
import { KINDS, type LearningExample, type SuggestionKind } from "./suggest.ts";

export type Outcome = "sent-as-is" | "sent-edited" | "own-message" | "unanswered";

/** A suggestion as the banner showed it; `kind` is absent on ones stored by older releases. */
export interface ShownSuggestion {
  readonly id: string;
  readonly label: string;
  readonly kind?: SuggestionKind;
  readonly why?: string;
}

export interface AcceptanceStats {
  readonly days: number;
  readonly batches: number;
  readonly threads: number;
  /** Batches after which the owner sent something. */
  readonly answered: number;
  /** Answered batches whose sent message came from a picked suggestion. */
  readonly picked: number;
  readonly sentAsIs: number;
  readonly sentEdited: number;
  readonly ownMessage: number;
  readonly dismissed: number;
  /** picked / answered; null when nothing was answered. */
  readonly acceptance: number | null;
  readonly byKind: Readonly<Record<SuggestionKind, { readonly shown: number; readonly picked: number }>>;
}

function norm(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/\s+/g, " ").trim();
}

/** Word-set Jaccard on normalized text, 0..1. */
export function similarity(a: string, b: string): number {
  const left = new Set(norm(a).split(" ").filter(Boolean));
  const right = new Set(norm(b).split(" ").filter(Boolean));
  if (left.size === 0 && right.size === 0) return 1;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}
export const EDITED_MIN_SIMILARITY = 0.5;

/**
 * A pick only counts when what he sent still resembles it: a draft he threw away and replaced
 * with his own text is his own message.
 */
export function classifyOutcome(
  batch: { readonly pickedId: string | null; readonly pickedLabel: string | null; readonly draft: string | null },
  sent: string,
): Exclude<Outcome, "unanswered"> {
  if (batch.pickedId === null) return "own-message";
  const base = batch.draft ?? batch.pickedLabel ?? "";
  if (norm(sent) === norm(base)) return "sent-as-is";
  return similarity(sent, base) >= EDITED_MIN_SIMILARITY ? "sent-edited" : "own-message";
}

export interface Learning {
  /** Opens a batch; closes the thread's previous open one as unanswered. */
  shown(threadId: string, projectId: string, suggestions: readonly ShownSuggestion[]): void;
  drafted(threadId: string, suggestionId: string, draft: string): void;
  dismissed(threadId: string): void;
  /** One of the owner's turns, as the turn scan first saw it: closes the batch shown before it. */
  ownerSent(threadId: string, text: string, at: number): void;
  /** His newest answered batches in this thread, then in its project; texts clipped. */
  examples(threadId: string, projectId: string): LearningExample[];
  stats(filter: { readonly days: number; readonly projectId?: string }): AcceptanceStats;
}

/** Part of the plugin's one migration list (server.ts): never edit a shipped statement. */
export const LEARNING_MIGRATIONS: string[] = [
  `CREATE TABLE batches (
     id TEXT PRIMARY KEY,
     thread_id TEXT NOT NULL,
     project_id TEXT NOT NULL,
     shown_at INTEGER NOT NULL,
     shown_json TEXT,
     kinds TEXT NOT NULL,
     picked_id TEXT,
     picked_kind TEXT,
     draft TEXT,
     dismissed INTEGER NOT NULL DEFAULT 0,
     sent TEXT,
     outcome TEXT,
     closed_at INTEGER
   )`,
  `CREATE INDEX batches_thread ON batches (thread_id, shown_at DESC)`,
  `CREATE INDEX batches_project ON batches (project_id, shown_at DESC)`,
];
/** Texts are kept for this many newest batches per thread and per project; older rows keep counts only. */
export const TEXTS_PER_SCOPE = 10;
export const ROW_RETENTION_DAYS = 90;
const EXAMPLES_PER_SCOPE = 5;
const EXAMPLE_CHARS = 300;
const SENT_CHARS = 2_000;
const DAY_MS = 24 * 60 * 60 * 1000;

type Row = {
  id: string;
  shown_at: number;
  shown_json: string | null;
  picked_id: string | null;
  draft: string | null;
  sent: string | null;
  outcome: string | null;
};

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max).trimEnd()}…`);

/** `db` must already have LEARNING_MIGRATIONS applied. */
export function openLearning(db: Database.Database, newId: () => string, now: () => number = Date.now): Learning {
  const open = db.prepare<[string], Row>(
    `SELECT id, shown_at, shown_json, picked_id, draft, sent, outcome FROM batches
     WHERE thread_id = ? AND closed_at IS NULL ORDER BY shown_at DESC LIMIT 1`,
  );
  const close = db.prepare(`UPDATE batches SET outcome = ?, sent = ?, closed_at = ? WHERE id = ?`);
  const insert = db.prepare(
    `INSERT INTO batches (id, thread_id, project_id, shown_at, shown_json, kinds) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const pick = db.prepare(`UPDATE batches SET picked_id = ?, picked_kind = ?, draft = ? WHERE id = ?`);
  const dismiss = db.prepare(`UPDATE batches SET dismissed = 1 WHERE id = ?`);
  const pruneTexts = db.prepare(
    `UPDATE batches SET shown_json = NULL, draft = NULL, sent = NULL
     WHERE shown_json IS NOT NULL AND id NOT IN (
       SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY shown_at DESC) AS n FROM batches) WHERE n <= ${TEXTS_PER_SCOPE}
       UNION
       SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY shown_at DESC) AS n FROM batches) WHERE n <= ${TEXTS_PER_SCOPE}
     )`,
  );
  const pruneRows = db.prepare(`DELETE FROM batches WHERE shown_at < ?`);
  const answeredIn = (scope: "thread_id" | "project_id") =>
    db.prepare<[string, number], Row>(
      `SELECT id, shown_at, shown_json, picked_id, draft, sent, outcome FROM batches
       WHERE ${scope} = ? AND outcome IN ('sent-as-is', 'sent-edited', 'own-message') AND shown_json IS NOT NULL AND sent IS NOT NULL
       ORDER BY shown_at DESC LIMIT ?`,
    );
  const answeredInThread = answeredIn("thread_id");
  const answeredInProject = answeredIn("project_id");

  const prune = () => {
    pruneTexts.run();
    pruneRows.run(now() - ROW_RETENTION_DAYS * DAY_MS);
  };
  const shownOf = (row: Row): ShownSuggestion[] => {
    try {
      return row.shown_json ? (JSON.parse(row.shown_json) as ShownSuggestion[]) : [];
    } catch {
      return [];
    }
  };

  return {
    shown(threadId, projectId, suggestions) {
      db.transaction(() => {
        const previous = open.get(threadId);
        if (previous) close.run("unanswered", null, now(), previous.id);
        const kinds = suggestions.map((item) => item.kind ?? "").join(",");
        insert.run(newId(), threadId, projectId, now(), JSON.stringify(suggestions), kinds);
        prune();
      })();
    },
    drafted(threadId, suggestionId, draft) {
      const batch = open.get(threadId);
      const picked = batch ? shownOf(batch).find((item) => item.id === suggestionId) : undefined;
      if (!batch || !picked) return;
      pick.run(suggestionId, picked.kind ?? null, draft, batch.id);
    },
    dismissed(threadId) {
      const batch = open.get(threadId);
      if (batch) dismiss.run(batch.id);
    },
    ownerSent(threadId, text, at) {
      const batch = open.get(threadId);
      // A turn older than the banner (read late, after a restart) answered an earlier one.
      if (!batch || at < batch.shown_at) return;
      const pickedLabel = shownOf(batch).find((item) => item.id === batch.picked_id)?.label ?? null;
      const outcome = classifyOutcome({ pickedId: batch.picked_id, pickedLabel, draft: batch.draft }, text);
      db.transaction(() => {
        close.run(outcome, clip(text, SENT_CHARS), at, batch.id);
        prune();
      })();
    },
    examples(threadId, projectId) {
      const rows = [...answeredInThread.all(threadId, EXAMPLES_PER_SCOPE), ...answeredInProject.all(projectId, EXAMPLES_PER_SCOPE)];
      const seen = new Set<string>();
      return rows
        .filter((row) => !seen.has(row.id) && Boolean(seen.add(row.id)))
        .map((row) => {
          const shown = shownOf(row);
          const index = shown.findIndex((item) => item.id === row.picked_id);
          return {
            shown: shown.map((item) => ({ label: item.label, kind: item.kind ?? null })),
            pickedIndex: index === -1 ? null : index,
            sent: clip(row.sent ?? "", EXAMPLE_CHARS),
            outcome: row.outcome as LearningExample["outcome"],
          };
        });
    },
    stats({ days, projectId }) {
      const since = now() - days * DAY_MS;
      const scope = projectId === undefined ? "" : "AND project_id = @projectId";
      const params = { since, ...(projectId === undefined ? {} : { projectId }) };
      const totals = db
        .prepare(
          `SELECT COUNT(*) AS batches, COUNT(DISTINCT thread_id) AS threads,
             SUM(outcome = 'sent-as-is') AS sentAsIs, SUM(outcome = 'sent-edited') AS sentEdited,
             SUM(outcome = 'own-message') AS ownMessage, SUM(dismissed) AS dismissed
           FROM batches WHERE shown_at >= @since ${scope}`,
        )
        .get(params) as Record<string, number | null>;
      const rows = db
        .prepare(`SELECT kinds, picked_kind, outcome FROM batches WHERE shown_at >= @since ${scope}`)
        .all(params) as { kinds: string; picked_kind: string | null; outcome: string | null }[];
      const byKind = Object.fromEntries(KINDS.map((kind) => [kind, { shown: 0, picked: 0 }])) as Record<
        SuggestionKind,
        { shown: number; picked: number }
      >;
      for (const row of rows) {
        for (const kind of row.kinds.split(",")) if (kind in byKind) byKind[kind as SuggestionKind].shown += 1;
        if (row.picked_kind && row.picked_kind in byKind && (row.outcome === "sent-as-is" || row.outcome === "sent-edited")) {
          byKind[row.picked_kind as SuggestionKind].picked += 1;
        }
      }
      const sentAsIs = totals.sentAsIs ?? 0;
      const sentEdited = totals.sentEdited ?? 0;
      const ownMessage = totals.ownMessage ?? 0;
      const answered = sentAsIs + sentEdited + ownMessage;
      const picked = sentAsIs + sentEdited;
      return {
        days,
        batches: totals.batches ?? 0,
        threads: totals.threads ?? 0,
        answered,
        picked,
        sentAsIs,
        sentEdited,
        ownMessage,
        dismissed: totals.dismissed ?? 0,
        acceptance: answered === 0 ? null : picked / answered,
        byKind,
      };
    },
  };
}

// The thread card: a short description of what one owner thread is for, built in the
// background and stored under the public `card` key of this plugin's thread metadata.
// docs/CARD.md is the contract for other readers (Feed, Recap, the morning brief).

import { z } from "zod";
import { bangkokNow } from "./thread-context.ts";

/** The only public key in this plugin's thread-metadata namespace. */
export const CARD_KEY = "card";

/**
 * Version 1 as written (strict: the plugin never writes extra fields). Added fields keep v: 1;
 * a breaking change bumps v. Readers, this plugin included, use `readCardV1`, which lets
 * unknown fields through, so an added field never turns a card into "no card".
 */
export const cardV1Schema = z
  .object({
    v: z.literal(1),
    threadId: z.string(),
    projectId: z.string(),
    /** Epoch ms when the run finished. */
    builtAt: z.number(),
    /** Asia/Bangkok date of builtAt, YYYY-MM-DD. */
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    /** Decided by the plugin (thread-context `threadRole`), never by the model. */
    role: z.enum(["orchestrator", "worker", "root"]),
    /** What the project does, one line. */
    project: z.string().max(200),
    /** The thread's task, one or two lines. */
    task: z.string().max(280),
    /** Up to 3 of the owner's goals this thread moves, each with how and its source. */
    goals: z.array(z.string().max(200)).max(3),
    /** Up to 4 earlier decisions or preferences that bear on the thread, each with a source hint. */
    decisions: z.array(z.string().max(200)).max(4),
    /** What the parent, children or neighbouring threads are doing that matters here. */
    siblings: z.string().max(300),
    /** How the thread sits against today's focus. */
    focusFit: z.string().max(200),
    /** Sources that failed during the run, e.g. "ov: timeout". */
    gaps: z.array(z.string().max(80)).max(6),
  })
  .strict();
export type CardV1 = z.infer<typeof cardV1Schema>;

const cardReaderSchema = cardV1Schema.loose();

/** A stored card, or null for none, another version, or a broken one. */
export function readCardV1(value: unknown): CardV1 | null {
  const parsed = cardReaderSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const ROLE_NAMES: Record<CardV1["role"], string> = {
  orchestrator: "оркестратор проекта",
  worker: "дочерний тред",
  root: "самостоятельный тред",
};

function age(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} ч` : `${Math.round(hours / 24)} дн`;
}

/** The card as text, for prompts and the CLI. Derived on every read, never stored. */
export function renderCard(card: CardV1, now: number): string {
  return [
    `Карточка треда (собрана ${card.day} ${bangkokNow(card.builtAt).time}, ${age(now - card.builtAt)} назад)`,
    `Роль: ${ROLE_NAMES[card.role]}`,
    `Проект: ${card.project}`,
    `Задача: ${card.task}`,
    ...card.goals.map((goal) => `Цель: ${goal}`),
    `Фокус дня: ${card.focusFit}`,
    ...card.decisions.map((decision) => `Решено раньше: ${decision}`),
    ...(card.siblings.trim() !== "" ? [`Соседи: ${card.siblings}`] : []),
    ...(card.gaps.length > 0 ? [`Нет данных: ${card.gaps.join(", ")}`] : []),
  ].join("\n");
}

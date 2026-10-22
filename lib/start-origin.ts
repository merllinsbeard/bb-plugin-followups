// How a thread's first message was requested, as bb's `message.dispatch` hook saw it. This is the
// only code on bb's admission path: the hook is fail-closed (a throw or a 10 s overrun fails the
// owner's message) and runs under a server-wide lock, so the handler never awaits, never throws,
// and always proceeds. Writing the value happens after the hook returns.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

/**
 * `app` for a thread the owner started in the app; `cli`, `plugin` or `sdk` for one an agent,
 * script, cron or plugin started. null when not seen: the thread predates this plugin version,
 * or the observer missed it. bb gives follow-ups no origin, so only a start turn has one.
 */
export type StartOrigin = "app" | "cli" | "plugin" | "sdk" | null;

export const META_START_ORIGIN = "startOrigin";

const originSchema = z.enum(["app", "cli", "plugin", "sdk"]);
const startTurnSchema = z.object({
  attempt: z.literal("start-turn"),
  thread: z.object({ id: z.string(), status: z.literal("pending") }),
  origin: originSchema,
});

export interface StartOriginStore {
  /** The hook handler: bb.experimental_hooks.on("message.dispatch", store.observe). */
  observe(context: unknown): { action: "proceed" };
  /** The value seen in this process first (it can beat its own write), else the stored one. */
  originOf(threadId: string, stored: unknown): StartOrigin;
}

export function createStartOriginStore(bb: BbPluginApi): StartOriginStore {
  const seen = new Map<string, Exclude<StartOrigin, null>>();

  async function persist(threadId: string, origin: Exclude<StartOrigin, null>): Promise<void> {
    try {
      await bb.sdk.threads.updatePluginMetadata({ threadId, set: { [META_START_ORIGIN]: origin } });
      if (seen.get(threadId) === origin) seen.delete(threadId);
    } catch (error) {
      try {
        bb.log.warn(`followups could not record how ${threadId} was started: ${error instanceof Error ? error.message : String(error)}`);
      } catch {
        // The plugin was unloaded meanwhile.
      }
    }
  }

  return {
    observe(context) {
      try {
        const start = startTurnSchema.safeParse(context);
        if (start.success) {
          const { thread, origin } = start.data;
          seen.set(thread.id, origin);
          // A drain or retry re-runs the hook with the same origin, so writing it again is harmless.
          setImmediate(() => void persist(thread.id, origin));
        }
      } catch {
        // Bookkeeping must never fail a message.
      }
      return { action: "proceed" };
    },
    originOf(threadId, stored) {
      const parsed = originSchema.safeParse(stored);
      return seen.get(threadId) ?? (parsed.success ? parsed.data : null);
    },
  };
}

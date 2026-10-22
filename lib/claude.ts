// The only way this plugin calls a model: one `claude -p` process per call, on the
// owner's own Claude login, in a fresh empty directory, with the output checked
// against a schema.

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface ModelChoice {
  readonly model: string;
  readonly effort: Effort;
}

/**
 * What a call may touch.
 * - none: no tools, no settings, no MCP, empty temp cwd.
 * - explore: `--restricted`; Read/Grep/Glob confined to cwd + `readDirs`; Bash allowed only
 *   as `ov find …`, each command capped at `bashTimeoutMs`.
 */
export type ToolAccess =
  | { readonly kind: "none" }
  | {
      readonly kind: "explore";
      readonly readDirs: readonly string[];
      readonly maxTurns: number;
      readonly bashTimeoutMs: number;
    };

export interface ClaudeCall<T> {
  /** Log label only. */
  readonly purpose: "suggest" | "draft" | "card";
  readonly choice: ModelChoice;
  readonly system: string;
  /** Goes on stdin. */
  readonly prompt: string;
  /** `--json-schema` is derived from it, and `structured_output` is parsed with it. */
  readonly output: z.ZodType<T>;
  readonly access: ToolAccess;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface CallStats {
  readonly ms: number;
  /** "claude-code/<model>@<effort>" */
  readonly model: string;
  /** Input the model had to read fresh: uncached plus newly cached tokens. */
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningOutputTokens?: number;
  readonly turns?: number;
  /** Tool calls the permission rules refused, by tool name. */
  readonly deniedTools?: readonly string[];
}

export type CallFailure = "missing-cli" | "timeout" | "aborted" | "model-error" | "bad-output";

export class ClaudeCallError extends Error {
  readonly failure: CallFailure;
  constructor(failure: CallFailure, message: string) {
    super(message);
    this.name = "ClaudeCallError";
    this.failure = failure;
  }
}

const STDOUT_MAX_BYTES = 2 * 1024 * 1024;
const DETAIL_CHARS = 400;

export function claudeArgs<T>(call: Pick<ClaudeCall<T>, "choice" | "system" | "output" | "access">): string[] {
  const schema = z.toJSONSchema(call.output, { io: "output" }) as Record<string, unknown>;
  delete schema.$schema;
  const base = [
    "-p",
    "--model", call.choice.model,
    "--effort", call.choice.effort,
    "--system-prompt", call.system,
    "--strict-mcp-config",
    "--setting-sources", "",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--output-format", "json",
    "--json-schema", JSON.stringify(schema),
  ];
  if (call.access.kind === "none") return [...base, "--tools", ""];
  return [
    ...base,
    "--restricted",
    "--tools", "Read,Grep,Glob,Bash",
    "--allowedTools", "Read", "Grep", "Glob", "Bash(ov find:*)",
    ...(call.access.readDirs.length > 0 ? ["--add-dir", ...call.access.readDirs] : []),
    "--max-turns", String(call.access.maxTurns),
  ];
}

const resultSchema = z.looseObject({
  is_error: z.boolean().optional(),
  subtype: z.string().optional(),
  result: z.string().optional(),
  structured_output: z.unknown().optional(),
  num_turns: z.number().optional(),
  usage: z
    .looseObject({
      input_tokens: z.number().optional(),
      cache_creation_input_tokens: z.number().optional(),
      cache_read_input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      output_tokens_details: z.looseObject({ thinking_tokens: z.number().optional() }).optional(),
    })
    .optional(),
  permission_denials: z.array(z.looseObject({ tool_name: z.string() })).optional(),
});

function sum(...values: (number | undefined)[]): number | undefined {
  return values.every((value) => value === undefined) ? undefined : values.reduce<number>((a, b) => a + (b ?? 0), 0);
}

/** The plugin's environment without its BB_* identity, which is not the model's to use. */
function childEnv(access: ToolAccess): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("BB_")) env[key] = value;
  if (access.kind === "explore") {
    env.BASH_DEFAULT_TIMEOUT_MS = String(access.bashTimeoutMs);
    env.BASH_MAX_TIMEOUT_MS = String(access.bashTimeoutMs);
  }
  return env;
}

function run(call: ClaudeCall<unknown>, cwd: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    if (call.signal?.aborted) return reject(new ClaudeCallError("aborted", "The call was cancelled."));
    const child = spawn("claude", claudeArgs(call), {
      cwd,
      env: childEnv(call.access),
      stdio: ["pipe", "pipe", "pipe"],
      // Own process group, so a kill also reaches the tools the model started.
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const kill = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const finish = (settle: () => void, killChild: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      call.signal?.removeEventListener("abort", onAbort);
      if (killChild) kill();
      settle();
    };
    const onAbort = () => finish(() => reject(new ClaudeCallError("aborted", "The call was cancelled.")), true);
    const timer = setTimeout(
      () => finish(() => reject(new ClaudeCallError("timeout", `No answer within ${call.timeoutMs}ms.`)), true),
      call.timeoutMs,
    );
    call.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > STDOUT_MAX_BYTES) {
        finish(() => reject(new ClaudeCallError("bad-output", "The answer is larger than 2 MiB.")), true);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4_000) stderr += chunk.toString("utf8");
    });
    child.on("error", (error: NodeJS.ErrnoException) =>
      finish(
        () =>
          reject(
            error.code === "ENOENT"
              ? new ClaudeCallError("missing-cli", "The claude CLI is not on PATH.")
              : new ClaudeCallError("model-error", `The claude CLI failed to start: ${error.message}`),
          ),
        false,
      ),
    );
    child.on("close", (code) => finish(() => resolve({ stdout, stderr, code }), false));
    child.stdin.on("error", () => {});
    child.stdin.end(call.prompt);
  });
}

export async function callClaude<T>(call: ClaudeCall<T>): Promise<{ value: T; stats: CallStats }> {
  const startedAt = Date.now();
  const cwd = await mkdtemp(join(tmpdir(), "followups-"));
  try {
    const { stdout, stderr, code } = await run(call as ClaudeCall<unknown>, cwd);
    let json: unknown;
    try {
      json = JSON.parse(stdout);
    } catch {
      throw new ClaudeCallError(
        "model-error",
        `The claude CLI returned no JSON (exit ${code}): ${(stderr || stdout).trim().slice(0, DETAIL_CHARS)}`,
      );
    }
    const result = resultSchema.safeParse(json);
    if (!result.success) throw new ClaudeCallError("model-error", "The claude CLI returned an unknown result shape.");
    const data = result.data;
    if (data.is_error !== false) {
      const detail = (data.result ?? data.subtype ?? stderr).trim().slice(0, DETAIL_CHARS);
      throw new ClaudeCallError("model-error", `The model call failed: ${detail || "no detail"}`);
    }
    const value = call.output.safeParse(data.structured_output);
    if (!value.success) {
      throw new ClaudeCallError("bad-output", `The answer does not match the schema: ${value.error.message.slice(0, DETAIL_CHARS)}`);
    }
    const usage = data.usage;
    const denied = (data.permission_denials ?? []).map((denial) => denial.tool_name);
    const stats: CallStats = {
      ms: Date.now() - startedAt,
      model: `claude-code/${call.choice.model}@${call.choice.effort}`,
      ...(usage ? {
        inputTokens: sum(usage.input_tokens, usage.cache_creation_input_tokens),
        cachedInputTokens: usage.cache_read_input_tokens,
        outputTokens: usage.output_tokens,
        reasoningOutputTokens: usage.output_tokens_details?.thinking_tokens,
      } : {}),
      ...(data.num_turns !== undefined ? { turns: data.num_turns } : {}),
      ...(denied.length > 0 ? { deniedTools: denied } : {}),
    };
    return { value: value.data, stats };
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  }
}

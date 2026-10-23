import { spawn } from "node:child_process";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];
export const DEFAULT_MODEL = "gpt-6-luna";
export const DEFAULT_EFFORT: Effort = "max";

const validatedChoice: unique symbol = Symbol("validated model choice");
export interface ModelChoice {
  readonly [validatedChoice]: true;
  readonly provider: keyof typeof transports;
  readonly model: string;
  readonly effort: Effort;
}

/** Requested access. Codex scope and command budgets are instructions, see docs/CARD.md. */
export type ToolAccess =
  | { readonly kind: "none" }
  | {
      readonly kind: "explore";
      readonly readDirs: readonly string[];
      readonly maxTurns: number;
      readonly bashTimeoutMs: number;
    };

export interface ModelCall<T> {
  readonly purpose: "suggest" | "draft" | "card";
  readonly choice: ModelChoice;
  readonly system: string;
  readonly prompt: string;
  readonly output: z.ZodType<T>;
  readonly access: ToolAccess;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface CallStats {
  readonly ms: number;
  readonly model: string;
  /** Fresh input, including Claude cache creation. */
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  /** Subset of outputTokens. */
  readonly reasoningOutputTokens?: number;
  readonly turns?: number;
  /** Recorded refusals only. Absence does not establish that access stayed in scope. */
  readonly deniedTools?: readonly string[];
}

export type CallFailure = "missing-cli" | "timeout" | "aborted" | "model-error" | "bad-output";
export class ModelCallError extends Error {
  readonly failure: CallFailure;
  constructor(failure: CallFailure, message: string) {
    super(message);
    this.name = "ModelCallError";
    this.failure = failure;
  }
}

const OUTPUT_MAX_BYTES = 2 * 1024 * 1024;
const STDERR_MAX_BYTES = 4_000;
const DETAIL_CHARS = 400;
// Accepted by codex-cli 0.163.0. Unknown flags fail the call rather than loosening it.
const CODEX_DISABLED = [
  "apps", "plugins", "memories", "skill_search", "tool_suggest", "multi_agent", "multi_agent_v2",
  "image_generation", "browser_use", "computer_use", "view_image", "goals", "sleep_tool",
] as const;

type Usage = Omit<CallStats, "ms" | "model">;
interface CallFiles {
  readonly cwd: string;
  readonly schema: string;
  readonly answer: string;
  readonly instructions: string;
  readonly tmp: string;
}
interface Invocation {
  readonly args: string[];
  readonly env: NodeJS.ProcessEnv;
}
interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
}
interface Transport {
  readonly executable: string;
  readonly acceptsModel: (model: string) => boolean;
  readonly subscriptionLabel: string;
  readonly statsPrefix: string;
  readonly prepare: (call: ModelCall<unknown>, files: CallFiles, schema: unknown) => Promise<Invocation>;
  readonly decode: (result: ProcessResult, files: CallFiles) => Promise<{ value: unknown; usage: Usage }>;
}

const transports = Object.freeze({
  codex: Object.freeze({
    executable: "codex",
    acceptsModel: (model: string) => /^gpt-\S+$/.test(model),
    subscriptionLabel: "codex exec on your ChatGPT login",
    statsPrefix: "codex",
    prepare: prepareCodex,
    decode: decodeCodex,
  }),
  claude: Object.freeze({
    executable: "claude",
    acceptsModel: (model: string) => /^claude-\S+$/.test(model) || ["haiku", "sonnet", "opus"].includes(model),
    subscriptionLabel: "claude -p on your Claude login",
    statsPrefix: "claude-code",
    prepare: prepareClaude,
    decode: decodeClaude,
  }),
} satisfies Record<string, Transport>);

export function readModelChoice(values: { readonly model?: unknown; readonly effort?: unknown }): ModelChoice {
  const model = typeof values.model === "string" && values.model.trim() ? values.model.trim() : DEFAULT_MODEL;
  const provider = (Object.keys(transports) as Array<keyof typeof transports>).find((key) => transports[key].acceptsModel(model));
  if (!provider) throw new ModelCallError("model-error", "Unknown model setting. Use gpt-*, claude-*, haiku, sonnet, or opus.");
  return Object.freeze({
    [validatedChoice]: true as const,
    provider,
    model,
    effort: EFFORTS.find((effort) => effort === values.effort) ?? DEFAULT_EFFORT,
  });
}

export function describeModel(choice: ModelChoice): string {
  return `${choice.model} at ${choice.effort} effort, through ${transports[choice.provider].subscriptionLabel}.`;
}

function childEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("BB_")));
}

async function prepareCodex(call: ModelCall<unknown>, files: CallFiles, schema: unknown): Promise<Invocation> {
  const access = call.access;
  const scope = access.kind === "none"
    ? "Use no tools. Answer only from the supplied source material."
    : [
        `Read only files under these project directories: ${JSON.stringify(access.readDirs)}.`,
        "Run no commands except ov find queries. Do not write files or call remote APIs that change state.",
        `Use at most 8 tool calls, within ${access.maxTurns} steps. Request a ${access.bashTimeoutMs}ms timeout for every command.`,
      ].join("\n");
  await writeFile(files.schema, JSON.stringify(schema), { mode: 0o600 });
  await writeFile(files.instructions, `${call.system}\n\n${scope}`, { mode: 0o600 });
  const env = childEnv();
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  env.TMPDIR = files.tmp;
  const disabled = [...CODEX_DISABLED, ...(access.kind === "none" ? ["shell_tool", "unified_exec"] : [])];
  return {
    env,
    args: [
      "exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check",
      "-s", access.kind === "none" ? "read-only" : "workspace-write",
      "-m", call.choice.model, "-c", `model_reasoning_effort=${call.choice.effort}`,
      "-c", `model_instructions_file=${JSON.stringify(files.instructions)}`,
      ...disabled.flatMap((name) => ["--disable", name]), "-c", 'web_search="disabled"',
      ...(access.kind === "explore" ? [
        "-c", "sandbox_workspace_write.network_access=true",
        "-c", "sandbox_workspace_write.exclude_slash_tmp=true",
        "-c", "sandbox_workspace_write.exclude_tmpdir_env_var=true",
      ] : []),
      "--output-schema", files.schema, "-o", files.answer, "--json", "-",
    ],
  };
}

async function prepareClaude(call: ModelCall<unknown>, _files: CallFiles, schema: unknown): Promise<Invocation> {
  const args = [
    "-p", "--model", call.choice.model, "--effort", call.choice.effort,
    "--system-prompt", call.system, "--strict-mcp-config", "--setting-sources", "",
    "--disable-slash-commands", "--no-session-persistence", "--output-format", "json",
    "--json-schema", JSON.stringify(schema),
  ];
  const env = childEnv();
  if (call.access.kind === "none") args.push("--tools", "");
  else {
    args.push("--restricted", "--tools", "Read,Grep,Glob,Bash", "--allowedTools", "Read", "Grep", "Glob", "Bash(ov find:*)");
    if (call.access.readDirs.length) args.push("--add-dir", ...call.access.readDirs);
    args.push("--max-turns", String(call.access.maxTurns));
    env.BASH_DEFAULT_TIMEOUT_MS = String(call.access.bashTimeoutMs);
    env.BASH_MAX_TIMEOUT_MS = String(call.access.bashTimeoutMs);
  }
  return { args, env };
}

function runProcess(executable: string, invocation: Invocation, call: ModelCall<unknown>, cwd: string, remainingMs: number): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (call.signal?.aborted) return reject(new ModelCallError("aborted", "The call was cancelled."));
    if (remainingMs <= 0) return reject(new ModelCallError("timeout", `No answer within ${call.timeoutMs}ms.`));
    const child = spawn(executable, invocation.args, { cwd, env: invocation.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: ModelCallError | undefined;
    const stop = (error: ModelCallError) => {
      if (failure) return;
      failure = error;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const onAbort = () => stop(new ModelCallError("aborted", "The call was cancelled."));
    const timer = setTimeout(() => stop(new ModelCallError("timeout", `No answer within ${call.timeoutMs}ms.`)), remainingMs);
    call.signal?.addEventListener("abort", onAbort, { once: true });
    if (call.signal?.aborted) onAbort();
    child.stdout.on("data", (chunk: Buffer) => {
      if (failure) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > OUTPUT_MAX_BYTES) stop(new ModelCallError("bad-output", "The model output is larger than 2 MiB."));
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const kept = chunk.subarray(0, Math.max(0, STDERR_MAX_BYTES - stderrBytes));
      if (kept.length) stderr.push(Buffer.from(kept));
      stderrBytes += kept.length;
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      stop(error.code === "ENOENT"
        ? new ModelCallError("missing-cli", `The ${executable} CLI is not on PATH.`)
        : new ModelCallError("model-error", `The ${executable} CLI failed: ${error.message.slice(0, DETAIL_CHARS)}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      call.signal?.removeEventListener("abort", onAbort);
      if (failure) reject(failure);
      else resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), code });
    });
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("error", () => stop(new ModelCallError("model-error", `Could not read the ${executable} CLI output.`)));
    }
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") stop(new ModelCallError("model-error", `Could not send input to the ${executable} CLI.`));
    });
    child.stdin.end(call.prompt);
  });
}

const tokens = z.number().int().nonnegative();
const claudeResultSchema = z.looseObject({
  is_error: z.boolean(),
  subtype: z.string().optional(),
  result: z.string().optional(),
  structured_output: z.unknown().optional(),
  num_turns: tokens.optional(),
  usage: z.looseObject({
    input_tokens: tokens.optional(), cache_creation_input_tokens: tokens.optional(), cache_read_input_tokens: tokens.optional(),
    output_tokens: tokens.optional(), output_tokens_details: z.looseObject({ thinking_tokens: tokens.optional() }).optional(),
  }).optional(),
  permission_denials: z.array(z.looseObject({ tool_name: z.string() })).optional(),
});
const codexUsageSchema = z.looseObject({
  input_tokens: tokens.optional(), cached_input_tokens: tokens.optional(), output_tokens: tokens.optional(), reasoning_output_tokens: tokens.optional(),
}).refine((usage) => usage.input_tokens === undefined || usage.cached_input_tokens === undefined || usage.cached_input_tokens <= usage.input_tokens);
const eventSchema = z.looseObject({ type: z.string() });
const completedSchema = z.looseObject({ type: z.literal("turn.completed"), usage: codexUsageSchema.optional() });
const errorSchema = z.looseObject({ type: z.literal("error"), message: z.string() });
const failedSchema = z.looseObject({ type: z.literal("turn.failed"), error: z.looseObject({ message: z.string() }) });

function checkExit(result: ProcessResult, executable: string): void {
  if (result.code !== 0) throw new ModelCallError("model-error", `The ${executable} CLI exited ${result.code}: ${result.stderr.trim().slice(0, DETAIL_CHARS) || "no detail"}`);
}

async function decodeClaude(result: ProcessResult): Promise<{ value: unknown; usage: Usage }> {
  checkExit(result, transports.claude.executable);
  let json: unknown;
  try { json = JSON.parse(result.stdout); }
  catch { throw new ModelCallError("model-error", "The claude CLI returned no JSON."); }
  const parsed = claudeResultSchema.safeParse(json);
  if (!parsed.success) throw new ModelCallError("model-error", "The claude CLI returned an unknown result shape.");
  const data = parsed.data;
  if (data.is_error) throw new ModelCallError("model-error", `The model call failed: ${(data.result ?? data.subtype ?? "no detail").slice(0, DETAIL_CHARS)}`);
  const usage = data.usage;
  const fresh = [usage?.input_tokens, usage?.cache_creation_input_tokens];
  const denied = data.permission_denials?.map((denial) => denial.tool_name) ?? [];
  return {
    value: data.structured_output,
    usage: {
      ...(usage ? {
        inputTokens: fresh.every((n) => n === undefined) ? undefined : fresh.reduce<number>((sum, n) => sum + (n ?? 0), 0),
        cachedInputTokens: usage.cache_read_input_tokens, outputTokens: usage.output_tokens,
        reasoningOutputTokens: usage.output_tokens_details?.thinking_tokens,
      } : {}),
      ...(data.num_turns !== undefined ? { turns: data.num_turns } : {}),
      ...(denied.length ? { deniedTools: denied } : {}),
    },
  };
}

function parseCodexEvents(stdout: string): Usage {
  let completed = false;
  let usage: Usage = {};
  for (const line of stdout.split("\n").filter((line) => line.trim())) {
    let json: unknown;
    try { json = JSON.parse(line); }
    catch { throw new ModelCallError("model-error", "The codex CLI returned invalid JSONL."); }
    const event = eventSchema.safeParse(json);
    if (!event.success) throw new ModelCallError("model-error", "The codex CLI returned an unknown event shape.");
    if (event.data.type === "error" || event.data.type === "turn.failed") {
      const parsed = event.data.type === "error" ? errorSchema.safeParse(json) : failedSchema.safeParse(json);
      if (!parsed.success) throw new ModelCallError("model-error", "The codex CLI returned an invalid error event.");
      const data = parsed.data;
      throw new ModelCallError("model-error", `The model call failed: ${(data.type === "error" ? data.message : data.error.message).slice(0, DETAIL_CHARS)}`);
    }
    if (event.data.type !== "turn.completed") continue;
    const parsed = completedSchema.safeParse(json);
    if (!parsed.success) throw new ModelCallError("model-error", "The codex CLI returned invalid completion usage.");
    completed = true;
    const raw = parsed.data.usage;
    if (raw) usage = {
      inputTokens: raw.input_tokens !== undefined && raw.cached_input_tokens !== undefined ? raw.input_tokens - raw.cached_input_tokens : undefined,
      cachedInputTokens: raw.cached_input_tokens, outputTokens: raw.output_tokens, reasoningOutputTokens: raw.reasoning_output_tokens,
    };
  }
  if (!completed) throw new ModelCallError("model-error", "The codex CLI did not complete the turn.");
  return usage;
}

async function decodeCodex(result: ProcessResult, files: CallFiles): Promise<{ value: unknown; usage: Usage }> {
  checkExit(result, transports.codex.executable);
  const usage = parseCodexEvents(result.stdout);
  let value: unknown;
  try {
    const file = await open(files.answer, "r");
    try {
      const bytes = Buffer.alloc(OUTPUT_MAX_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await file.read(bytes, length, bytes.length - length);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length > OUTPUT_MAX_BYTES) throw new ModelCallError("bad-output", "The answer is larger than 2 MiB.");
      value = JSON.parse(bytes.subarray(0, length).toString("utf8"));
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof ModelCallError) throw error;
    throw new ModelCallError("bad-output", "The codex CLI returned no valid final JSON file.");
  }
  return { value, usage };
}

export async function callModel<T>(call: ModelCall<T>): Promise<{ value: T; stats: CallStats }> {
  const startedAt = Date.now();
  if (call.signal?.aborted) throw new ModelCallError("aborted", "The call was cancelled.");
  const root = await mkdtemp(join(tmpdir(), "followups-")).catch(() => {
    throw new ModelCallError("model-error", "Could not create a private model-call directory.");
  });
  const files: CallFiles = {
    cwd: join(root, "cwd"), tmp: join(root, "cwd", "tmp"), schema: join(root, "schema.json"),
    answer: join(root, "answer.json"), instructions: join(root, "instructions.md"),
  };
  try {
    await mkdir(files.tmp, { recursive: true, mode: 0o700 });
    const schema = z.toJSONSchema(call.output, { io: "output" }) as Record<string, unknown>;
    delete schema.$schema;
    const transport: Transport = transports[call.choice.provider];
    const invocation = await transport.prepare(call as ModelCall<unknown>, files, schema);
    const result = await runProcess(transport.executable, invocation, call as ModelCall<unknown>, files.cwd, call.timeoutMs - (Date.now() - startedAt));
    const decoded = await transport.decode(result, files);
    const value = call.output.safeParse(decoded.value);
    if (!value.success) throw new ModelCallError("bad-output", `The answer does not match the schema: ${value.error.message.slice(0, DETAIL_CHARS)}`);
    return { value: value.data, stats: { ...decoded.usage, ms: Date.now() - startedAt, model: `${transport.statsPrefix}/${call.choice.model}@${call.choice.effort}` } };
  } catch (error) {
    if (error instanceof ModelCallError) throw error;
    throw new ModelCallError("model-error", "Could not prepare or read the model call's local files.");
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {
      throw new ModelCallError("model-error", "Could not remove the model call's temporary files.");
    });
  }
}

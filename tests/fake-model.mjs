import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

const FEATURES = new Set([
  "apps", "plugins", "memories", "skill_search", "tool_suggest", "multi_agent", "multi_agent_v2",
  "image_generation", "browser_use", "computer_use", "view_image", "goals", "sleep_tool", "shell_tool", "unified_exec",
]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function strictSchema(schema) {
  if (!schema || typeof schema !== "object") return null;
  if (schema.type === "object") {
    if (schema.additionalProperties !== false) return "'additionalProperties' must be false";
    for (const key of Object.keys(schema.properties ?? {})) {
      if (!schema.required?.includes(key)) return `'required' is required to include every key in properties. Missing '${key}'`;
    }
  }
  for (const value of Object.values(schema)) {
    for (const child of [value].flat()) {
      const error = strictSchema(child);
      if (error) return error;
    }
  }
  return null;
}

export async function main(provider) {
  const dir = process.env.FAKE_MODEL_DIR;
  if (!dir) throw new Error("FAKE_MODEL_DIR is not set");
  const argv = process.argv.slice(2);
  const flag = (name) => argv[argv.indexOf(name) + 1];
  if (provider === "codex") {
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "--disable" && !FEATURES.has(argv[i + 1])) {
        process.stderr.write(`Unknown feature flag: ${argv[i + 1]}\n`);
        process.exitCode = 1;
        return;
      }
    }
  }
  const schema = JSON.parse(provider === "codex" ? readFileSync(flag("--output-schema"), "utf8") : flag("--json-schema"));
  const properties = Object.keys(schema.properties ?? {});
  const kind = properties.includes("candidates") ? "suggest" : properties.includes("message") ? "draft" : properties.includes("task") ? "card" : "unknown";
  let stdin = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) stdin += chunk;
  const log = join(dir, "calls.jsonl");
  const earlier = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map(JSON.parse).filter((call) => call.kind === kind).length : 0;
  const fixtures = JSON.parse(readFileSync(join(dir, "fixtures.json"), "utf8"));
  const steps = [fixtures[kind] ?? {}].flat();
  const step = steps[Math.min(earlier, steps.length - 1)];
  const child = step.spawnChild ? spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }) : null;
  const instructions = argv.find((arg) => arg.startsWith("model_instructions_file="));
  const instructionPath = instructions ? JSON.parse(instructions.slice("model_instructions_file=".length)) : null;
  appendFileSync(log, JSON.stringify({
    provider, kind, argv, stdin, schema,
    system: provider === "codex" ? readFileSync(instructionPath, "utf8") : flag("--system-prompt"),
    cwd: process.cwd(), tmpdir: process.env.TMPDIR,
    bashTimeoutMs: process.env.BASH_MAX_TIMEOUT_MS ?? null,
    bbIdentityPresent: Object.keys(process.env).some((key) => key.startsWith("BB_")),
    apiKeyPresent: !!(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY),
    pid: process.pid, childPid: child?.pid, at: Date.now(),
  }) + "\n");
  if (step.delayMs) await sleep(step.delayMs);
  if (step.gate) while (!existsSync(step.gate)) await sleep(20);
  if (step.stderrBytes) process.stderr.write("e".repeat(step.stderrBytes));
  if (provider === "claude") {
    if (step.fail === "exit") { process.stderr.write("fake claude: failed on purpose\n"); process.exitCode = 1; return; }
    if (step.fail === "garbage") { process.stdout.write("this is not json"); return; }
    process.stdout.write(JSON.stringify({
      type: "result", subtype: step.fail === "is_error" ? "error_during_execution" : "success",
      is_error: step.fail === "is_error", result: step.fail === "is_error" ? "fake claude: model error on purpose" : "",
      num_turns: 2, structured_output: step.output ?? null,
      usage: step.usage ?? { input_tokens: 900, cache_creation_input_tokens: 100, cache_read_input_tokens: 2000, output_tokens: 300, output_tokens_details: { thinking_tokens: 200 } },
      permission_denials: (step.denials ?? []).map((tool_name) => ({ tool_name })),
    }));
    process.exitCode = step.exitCode ?? 0;
    return;
  }
  const schemaError = strictSchema(schema);
  if (schemaError) {
    process.stdout.write(JSON.stringify({ type: "turn.failed", error: { message: schemaError } }));
    process.stderr.write(schemaError);
    process.exitCode = 1;
    return;
  }
  if (step.fail === "exit") { process.stderr.write("fake codex: failed on purpose\n"); process.exitCode = 1; return; }
  const events = step.events ?? [
    { type: "thread.started", thread_id: "fake" }, { type: "turn.started" }, { type: "future.event", detail: "ignored" },
    { type: "item.completed", item: { type: "agent_message", text: '{"message":"intermediate answer"}' } },
    ...(step.fail === "is_error" ? [{ type: "error", message: "fake codex: model error on purpose" }, { type: "turn.failed", error: { message: "failed" } }] : []),
    ...(step.missingCompletion ? [] : [{ type: "turn.completed", usage: step.usage ?? { input_tokens: 3000, cached_input_tokens: 2000, output_tokens: 300, reasoning_output_tokens: 200 } }]),
  ];
  const stdout = step.stdout ?? events.map(JSON.stringify).join("\n");
  if (!step.missingFile) writeFileSync(flag("-o"), step.rawAnswer ?? (step.fail === "garbage" ? "not JSON" : JSON.stringify(step.output ?? null)));
  if (step.chunked) {
    const buffer = Buffer.from(stdout);
    for (let at = 0; at < buffer.length; at += 7) { process.stdout.write(buffer.subarray(at, at + 7)); await sleep(1); }
  } else process.stdout.write(stdout);
  process.exitCode = step.exitCode ?? 0;
}

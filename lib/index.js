/**
 * @module dsh-subagent-zcode
 *
 * One-shot ZCode delegation provider for DeepSeek Harness.
 *
 * Each accepted run spawns the locally installed ZCode CLI in headless mode
 * (`zcode.cjs --prompt <task> --cwd <dir> --mode <mode> --output-format json`)
 * inside the delegating session's workspace, waits for its single turn, and
 * publishes only the root answer text. The provider advertises the
 * out-of-process capability floor: no parent context, no follow-up input, no
 * structured output, no depth control.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import z from "@deepseek-ai/schemastery";
import {
  NO_START_CAPABILITIES,
  assertPositiveFinite,
  assertUsableCwd,
  settleRunResult,
  subprocessRunHandle,
} from "@deepseek-ai/dsh-subagent";

export const name = "subagent-zcode";

/** Shared subagent registry plus the process seam used to drive the native CLI. */
export const inject = ["subagents", "subprocess"];

const DEFAULT_ENTRY_PATH = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";
const DEFAULT_PROVIDER_CONFIG_PATH =
  "/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json";
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Permission modes accepted by `--mode`. `yolo` is allowed here but never the
 * default: the CLI itself falls back to `yolo` when `--mode` is omitted, and the
 * provider always passes an explicit mode so that fallback never decides.
 */
const MODES = ["plan", "build", "edit", "guarded", "yolo"];

export const Config = z.object({
  /** Registry name other plugins use to reference this provider. */
  providerName: z.string().min(1).default("zcode"),
  /** Path to the ZCode CLI entry script inside the app bundle. */
  entryPath: z.string().min(1).default(DEFAULT_ENTRY_PATH),
  /** Node executable used to run the entry script. */
  nodePath: z.string().min(1).default(process.execPath),
  /** Bundled provider catalog the CLI needs before it can open a session. */
  providerConfigPath: z.string().min(1).default(DEFAULT_PROVIDER_CONFIG_PATH),
  /** Native permission mode pinned for every delegation. */
  mode: z.union([...MODES]).default("edit"),
  /** Explicit child environment overlay applied after credential scrubbing. */
  env: z.dict(z.string()).default({}),
  /** Grace period for process-range teardown. */
  disposeGraceMs: z.number().default(5_000),
});

/**
 * Collect the task text from the request's content blocks.
 * @param prompt - already validated child message blocks.
 * @returns the joined non-empty task text.
 */
function textTask(prompt) {
  const texts = [];
  for (const block of prompt) {
    if (block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
    }
  }
  const task = texts.join("\n\n").trim();
  if (task.length === 0) throw new Error("subagent-zcode: the one-shot task must not be empty");
  return task;
}

/**
 * Parse the CLI's JSON envelope, tolerating diagnostic lines around it.
 * @param stdout - captured standard output.
 * @returns the parsed envelope, or undefined when nothing usable was printed.
 */
function parseEnvelope(stdout) {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === "object") return parsed;
  } catch {}
  const lines = trimmed.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (line.length === 0 || !line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed !== null && typeof parsed === "object") return parsed;
    } catch {}
  }
  return undefined;
}

/**
 * Keep provider-authored diagnostic text free of tool input and file content:
 * exit facts plus a short, single-line stderr tail.
 * @param text - captured stderr.
 * @returns a bounded diagnostic line.
 */
function stderrTail(text) {
  const collapsed = text.replaceAll(/\s+/g, " ").trim();
  return collapsed.length <= 400 ? collapsed : `${collapsed.slice(-400)}…`;
}

/**
 * Start one ZCode delegation.
 * @param request - resolved subagent start request.
 * @param config - pinned provider configuration.
 * @returns the owned run handle.
 */
function startRun(request, config, ctx) {
  for (const [field, value] of [
    ["entryPath", config.entryPath],
    ["providerConfigPath", config.providerConfigPath],
  ]) {
    if (!existsSync(value)) {
      throw new Error(
        `subagent-zcode: ${field} not found at ${value}. Install the ZCode app, or set ${field} in the provider config (see README).`,
      );
    }
  }
  const cwd = assertUsableCwd("subagent-zcode", "child cwd", request.cwd);
  const task = textTask(request.prompt);
  const child = ctx.subprocess.spawn({
    argv: [
      config.nodePath,
      config.entryPath,
      "--prompt",
      task,
      "--cwd",
      cwd,
      "--mode",
      config.mode,
      "--output-format",
      "json",
    ],
    cwd,
    stdio: {
      stdin: "ignore",
      stdout: { maxBytes: 8_000_000 },
      stderr: { maxBytes: 64_000 },
    },
    graceMs: config.disposeGraceMs,
    signal: request.signal,
    env: {
      ...config.env,
      ZCODE_NODE_FALLBACK_EXEC_PATH: config.nodePath,
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: config.providerConfigPath,
    },
  });

  const runAbort = new AbortController();
  const onAbort = () => {
    runAbort.abort();
  };

  let output = [];
  let diagnostic;
  let stdoutText = "";
  let stderrText = "";

  const readStreams = () => {
    try {
      stdoutText = child.collected.stdout?.readFrom(0).text ?? "";
    } catch {}
    try {
      stderrText = child.collected.stderr?.readFrom(0).text ?? "";
    } catch {}
  };

  const attempt = async () => {
    const outcome = await child.done;
    readStreams();
    if (runAbort.signal.aborted) throw new Error("subagent-zcode: run was cancelled");
    if (outcome.exitCode !== 0) {
      const exit = outcome.exitCode === null ? `signal ${outcome.signal ?? "unknown"}` : `code ${outcome.exitCode}`;
      diagnostic = `zcode exited with ${exit}${stderrText.trim() === "" ? "" : `: ${stderrTail(stderrText)}`}`;
      throw new Error(diagnostic);
    }
    const envelope = parseEnvelope(stdoutText);
    const response = typeof envelope?.response === "string" ? envelope.response : "";
    if (response.trim().length === 0) {
      diagnostic = `zcode completed without an answer${stderrText.trim() === "" ? "" : `: ${stderrTail(stderrText)}`}`;
      throw new Error(diagnostic);
    }
    output = [{ type: "text", text: response }];
    return { output, stopReason: "completed" };
  };

  const result = settleRunResult({
    attempt,
    collectOutput: () => output,
    collectDiagnostic: () => diagnostic,
    cancelled: () => runAbort.signal.aborted,
    onError: (error, stopReason) => {
      ctx.logger?.warn?.(`subagent-zcode: child run failed (${stopReason}): ${error.message}`);
    },
    signal: request.signal,
    onAbort,
  });

  return subprocessRunHandle({
    id: randomUUID(),
    result,
    signal: request.signal,
    onAbort,
    requestCancel: () => {
      runAbort.abort();
      child.terminate();
    },
    teardown: async () => {
      child.terminate();
      try {
        await child.waitForExit(AbortSignal.timeout(config.disposeGraceMs * 2));
      } catch {}
    },
  });
}

var ZcodeProvider = class {
  name;
  ctx;
  config;
  capabilities = NO_START_CAPABILITIES;
  inheritsParentContext = false;

  constructor(name, ctx, config) {
    this.name = name;
    this.ctx = ctx;
    this.config = config;
  }

  start(request) {
    return startRun(request, this.config, this.ctx);
  }
};

/**
 * Register one ZCode provider under its configured name.
 * @param ctx - context carrying the shared subagent and subprocess services.
 * @param config - entry paths, pinned mode, environment overlay, and teardown grace.
 */
export function apply(ctx, config) {
  const resolved = {
    providerName: config.providerName ?? "zcode",
    entryPath: config.entryPath ?? DEFAULT_ENTRY_PATH,
    nodePath: config.nodePath ?? process.execPath,
    providerConfigPath: config.providerConfigPath ?? DEFAULT_PROVIDER_CONFIG_PATH,
    mode: config.mode ?? "edit",
    env: config.env ?? {},
    disposeGraceMs: config.disposeGraceMs ?? 5_000,
  };
  assertPositiveFinite("subagent-zcode", "disposeGraceMs", resolved.disposeGraceMs);
  if (resolved.disposeGraceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`subagent-zcode: disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`);
  }
  ctx.subagents.registerProvider(new ZcodeProvider(resolved.providerName, ctx, resolved));
}

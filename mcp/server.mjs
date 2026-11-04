#!/usr/bin/env node
/**
 * Minimal stdio MCP server that exposes the locally installed ZCode CLI as a
 * delegation tool for Claude Code (or any MCP client).
 *
 * One tool: `delegate` — spawns the ZCode CLI headlessly in a working
 * directory, waits for its single turn, and returns only the final answer.
 * No dependencies: newline-delimited JSON-RPC 2.0 over stdin/stdout.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import process from "node:process";

const APP_ROOT = "/Applications/ZCode.app/Contents/Resources";
const DEFAULT_ENTRY = `${APP_ROOT}/glm/zcode.cjs`;
const DEFAULT_PROVIDER_CONFIG = `${APP_ROOT}/config/provider/zcode-builtin.json`;
const MODES = ["plan", "build", "edit", "guarded", "yolo"];
const SERVER_INFO = { name: "zcode", version: "1.0.0" };

const TOOL = {
  name: "delegate",
  description:
    "Delegate a self-contained task to the locally installed ZCode CLI (the GLM coding agent) and get back only its final answer. " +
    "Each call starts a fresh, isolated native session in the given working directory: the delegate cannot see this conversation, cannot be asked follow-up questions, and its tool activity, stderr and diffs never come back — only the final answer text. " +
    "Write the prompt as a complete brief: paths, constraints, acceptance criteria, and the exact answer format you want.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "Complete, self-contained task text. Everything the delegate needs must be in here.",
      },
      cwd: {
        type: "string",
        description: "Absolute working directory for the delegate. Defaults to this server's working directory.",
      },
      mode: {
        type: "string",
        enum: MODES,
        description:
          "Native permission mode. 'plan' analyzes only, 'edit' writes workspace files without approval but cannot run commands, 'build' needs approval for writes (fails with no approver), 'guarded' allows ordinary calls but needs approval for dangerous commands, 'yolo' skips permission prompts and can run commands (use for self-testing tasks). Defaults to 'edit'.",
      },
      timeout_ms: {
        type: "number",
        description: "Wall-clock limit for the whole delegation. Defaults to 300000 (5 minutes).",
      },
    },
    required: ["prompt"],
    additionalProperties: false,
  },
};

/** Write one JSON-RPC message as a single line. */
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/** Reply to a request. */
function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

/** Fail a request. */
function fail(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

/**
 * Parse the CLI's JSON envelope, tolerating diagnostic lines around it.
 * @param {string} stdout - captured standard output.
 * @returns {object|undefined} the parsed envelope when one exists.
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
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed !== null && typeof parsed === "object") return parsed;
    } catch {}
  }
  return undefined;
}

/**
 * Run one ZCode delegation.
 * @param {object} args - tool arguments.
 * @returns {Promise<{text: string, isError: boolean}>} tool result payload.
 */
async function delegate(args) {
  const prompt = typeof args?.prompt === "string" ? args.prompt.trim() : "";
  if (prompt.length === 0) return { text: "delegate: `prompt` must be a non-empty string", isError: true };

  const cwd = typeof args?.cwd === "string" && args.cwd.length > 0 ? args.cwd : process.cwd();
  if (!existsSync(cwd)) return { text: `delegate: working directory does not exist: ${cwd}`, isError: true };

  const mode = MODES.includes(args?.mode) ? args.mode : "edit";
  const timeoutMs =
    typeof args?.timeout_ms === "number" && Number.isFinite(args.timeout_ms) && args.timeout_ms > 0
      ? args.timeout_ms
      : 300_000;

  const argv = [
    process.execPath,
    DEFAULT_ENTRY,
    "--prompt",
    prompt,
    "--cwd",
    cwd,
    "--mode",
    mode,
    "--output-format",
    "json",
  ];

  const child = spawn(argv[0], argv.slice(1), {
    cwd,
    env: {
      ...process.env,
      ZCODE_NODE_FALLBACK_EXEC_PATH: process.execPath,
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: DEFAULT_PROVIDER_CONFIG,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });

  const timer = setTimeout(() => {
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref?.();
  }, timeoutMs);

  const outcome = await new Promise((resolve) => {
    child.on("error", (error) => resolve({ spawnError: error }));
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);

  if (outcome.spawnError) {
    return { text: `delegate: failed to start ZCode: ${outcome.spawnError.message}`, isError: true };
  }
  if (outcome.code !== 0) {
    const detail = stderr.replaceAll(/\s+/g, " ").trim().slice(-400);
    return {
      text: `delegate: ZCode exited with ${outcome.code === null ? `signal ${outcome.signal}` : `code ${outcome.code}`}${detail ? `: ${detail}` : ""}`,
      isError: true,
    };
  }

  const envelope = parseEnvelope(stdout);
  const answer = typeof envelope?.response === "string" ? envelope.response : "";
  if (answer.trim().length === 0) {
    const detail = stderr.replaceAll(/\s+/g, " ").trim().slice(-400);
    return { text: `delegate: ZCode finished without an answer${detail ? `: ${detail}` : ""}`, isError: true };
  }

  const meta = [];
  if (typeof envelope.sessionId === "string") meta.push(`session ${envelope.sessionId}`);
  if (typeof envelope.model === "string") meta.push(`model ${envelope.model}`);
  const usage = envelope.usage;
  if (usage && typeof usage.totalTokens === "number") meta.push(`tokens ${usage.totalTokens}`);
  meta.push(`mode ${mode}`);

  return { text: `${answer}\n\n— zcode (${meta.join(", ")})`, isError: false };
}

/** Handle one parsed JSON-RPC message. */
async function handle(message) {
  if (message === null || typeof message !== "object" || typeof message.method !== "string") return;
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "Use the `delegate` tool to hand a self-contained coding task to the local ZCode CLI. It returns only the final answer.",
      });
      return;
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "ping":
      reply(id, {});
      return;
    case "tools/list":
      reply(id, { tools: [TOOL] });
      return;
    case "tools/call": {
      if (params?.name !== TOOL.name) {
        fail(id, -32602, `unknown tool: ${String(params?.name)}`);
        return;
      }
      const result = await delegate(params?.arguments ?? {});
      reply(id, {
        content: [{ type: "text", text: result.text }],
        ...(result.isError ? { isError: true } : {}),
      });
      return;
    }
    default:
      if (!isNotification) fail(id, -32601, `method not found: ${method}`);
  }
}

let buffer = "";
let pending = 0;
let inputEnded = false;
/** Exit only once no delegation is still in flight, so a closing client cannot truncate one. */
function exitWhenIdle() {
  if (inputEnded && pending === 0) process.exit(0);
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf("\n");
    if (line.length === 0) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    pending += 1;
    handle(message)
      .catch((error) => {
        if (message?.id !== undefined && message?.id !== null) {
          fail(message.id, -32603, `internal error: ${error?.message ?? String(error)}`);
        }
      })
      .finally(() => {
        pending -= 1;
        exitWhenIdle();
      });
  }
});
process.stdin.on("end", () => {
  inputEnded = true;
  exitWhenIdle();
});

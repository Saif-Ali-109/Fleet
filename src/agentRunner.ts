import { spawn } from "node:child_process";
import { closeSync, copyFileSync, fstatSync, mkdirSync, openSync, readSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentResult, Role, RolePolicy, RunContext } from "./types.js";

export interface RunWorkerOpts {
  /** Reasoning-effort variant override (else policy.variant). */
  variant?: RolePolicy["variant"];
  /** Called for every assistant text chunk (for the live TUI). */
  onText?: (chunk: string) => void;
  /** Called for every opencode stream event (thinking, tool calls, results, etc.). */
  onEvent?: (ev: Record<string, unknown>) => void;
}

interface ParsedStream {
  text: string;
  sessionID: string | null;
  tokens: AgentResult["tokens"];
  costUsd: number;
  sawError: boolean;
  errorMsg?: string;
}

const OPENCODE_BIN = process.env.OPENCODE_BIN ?? "opencode";

/** Run one opencode worker for `role`, trying `policy.model` then each fallback in order. */
export async function runWorker(
  role: Role,
  task: string,
  ctx: RunContext,
  policy: RolePolicy,
  opts: RunWorkerOpts = {},
): Promise<AgentResult> {
  const tracePath = join(ctx.tracesDir, `${role}.jsonl`);
  await mkdir(dirname(tracePath), { recursive: true });
  const startedAt = Date.now();

  if (ctx.dryRun) {
    return stubResult(role, policy.model, tracePath, startedAt);
  }

  const env = buildEnv(ctx);
  const models = [policy.model, ...policy.fallbacks];
  let last: ParsedStream | null = null;
  let lastModel = policy.model;
  const attempts: NonNullable<AgentResult["attempts"]> = [];

  for (const model of models) {
    lastModel = model;
    const parsed = await spawnOnce(role, task, ctx, model, policy, tracePath, opts, env);
    last = parsed;
    const ok = !parsed.sawError && parsed.text.trim().length > 0;
    attempts.push({ model, ok, error: parsed.errorMsg });
    if (ok) {
      return finalize(role, model, parsed, tracePath, startedAt, true, undefined, attempts);
    }
    // else fall through to the next model in the pool
  }

  return finalize(
    role,
    lastModel,
    last ?? emptyStream(),
    tracePath,
    startedAt,
    false,
    last?.errorMsg ?? "all models failed",
    attempts,
  );
}

export function buildArgs(
  role: Role,
  task: string,
  ctx: RunContext,
  model: string,
  policy: RolePolicy,
  opts: RunWorkerOpts,
): string[] {
  const args = ["run", "--agent", role, "-m", model, "--dir", ctx.worktreeDir, "--format", "json"];
  const variant = opts.variant ?? policy.variant;
  if (variant) args.push("--variant", variant);
  args.push(task); // positional message; passed as argv so the shell never parses it
  return args;
}

function spawnOnce(
  role: Role,
  task: string,
  ctx: RunContext,
  model: string,
  policy: RolePolicy,
  tracePath: string,
  opts: RunWorkerOpts,
  env: NodeJS.ProcessEnv,
): Promise<ParsedStream> {
  return new Promise((resolve) => {
    const args = buildArgs(role, task, ctx, model, policy, opts);
    const traceDir = dirname(tracePath);
    mkdirSync(traceDir, { recursive: true });
    const stderrPath = join(traceDir, `${role}.stderr.log`);
    const fdOut = openSync(tracePath, "a");
    const fdErr = openSync(stderrPath, "a");
    const startOffset = fstatSync(fdOut).size;

    let settled = false;
    let stopTail = () => {};
    const settle = (s: ParsedStream) => {
      if (settled) return;
      settled = true;
      stopTail();
      try {
        closeSync(fdOut);
      } catch {
        // already closed
      }
      try {
        closeSync(fdErr);
      } catch {
        // already closed
      }
      resolve(s);
    };

    try {
      const child = spawn(OPENCODE_BIN, args, {
        cwd: ctx.rootDir,
        env,
        stdio: ["ignore", fdOut, fdErr],
      });
      stopTail = startTailing(tracePath, startOffset, opts.onText, opts.onEvent);

      child.on("error", (err) => {
        settle({
          text: "",
          sessionID: null,
          tokens: zeroTokens(),
          costUsd: 0,
          sawError: true,
          errorMsg: `spawn failed: ${err.message}`,
        });
      });

      child.on("close", (code) => {
        const parsed = parseTrace(tracePath, opts, startOffset);
        if (code !== 0 && !parsed.sawError) {
          parsed.sawError = true;
          parsed.errorMsg = `exit ${code}: ${readStderrTail(stderrPath)}`;
        }
        settle(parsed);
      });
    } catch (err) {
      settle({
        text: "",
        sessionID: null,
        tokens: zeroTokens(),
        costUsd: 0,
        sawError: true,
        errorMsg: `spawn failed: ${(err as Error).message}`,
      });
    }
  });
}

/** Per-run opencode env: isolated data dir (fresh SQLite DB per run) + seeded auth. */
function buildEnv(ctx: RunContext): NodeJS.ProcessEnv {
  const dataHome = join(ctx.runDir, ".opencode-data");
  try {
    mkdirSync(join(dataHome, "opencode"), { recursive: true });
    copyFileSync(
      join(homedir(), ".local", "share", "opencode", "auth.json"),
      join(dataHome, "opencode", "auth.json"),
    );
  } catch {
    // non-fatal: continue without a seeded auth file
  }
  return {
    ...process.env,
    OPENCODE_CONFIG: join(ctx.rootDir, "opencode.json"),
    XDG_DATA_HOME: dataHome,
  };
}

/** Read back this attempt's NDJSON from the trace file and build the parsed shape. */
export function parseTrace(tracePath: string, opts: RunWorkerOpts, startOffset: number): ParsedStream {
  const acc: ParsedStream = { text: "", sessionID: null, tokens: zeroTokens(), costUsd: 0, sawError: false };
  let raw: string;
  try {
    raw = readFileSync(tracePath, "utf8");
  } catch {
    return acc;
  }
  const body = startOffset > 0 ? raw.slice(startOffset) : raw;
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue; // non-JSON noise that leaked into the trace
    }
    if (ev.sessionID && !acc.sessionID) acc.sessionID = ev.sessionID;
    const part = ev.part ?? {};
    if (ev.type === "text" && typeof part.text === "string") {
      acc.text += part.text;
    } else if (ev.type === "step_finish") {
      if (part.tokens) {
        acc.tokens.input += part.tokens.input ?? 0;
        acc.tokens.output += part.tokens.output ?? 0;
        acc.tokens.reasoning += part.tokens.reasoning ?? 0;
        acc.tokens.total += part.tokens.total ?? 0;
      }
      acc.costUsd += part.cost ?? 0;
    } else if (ev.type === "error" || part.type === "error") {
      acc.sawError = true;
      acc.errorMsg = part.error ?? ev.error ?? "opencode error event";
    }
  }
  return acc;
}

/** Last 400 chars of the per-attempt stderr log file, trimmed. */
export function readStderrTail(stderrPath: string): string {
  try {
    return readFileSync(stderrPath, "utf8").slice(-400).trim();
  } catch {
    return "";
  }
}

function finalize(
  role: Role,
  model: string,
  s: ParsedStream,
  tracePath: string,
  startedAt: number,
  ok: boolean,
  error?: string,
  attempts?: NonNullable<AgentResult["attempts"]>,
): AgentResult {
  return {
    role,
    ok,
    sessionID: s.sessionID,
    model,
    attempts,
    text: s.text,
    tokens: s.tokens,
    costUsd: s.costUsd,
    error,
    tracePath,
    startedAt,
    endedAt: Date.now(),
  };
}

function stubResult(role: Role, model: string, tracePath: string, startedAt: number): AgentResult {
  return {
    role,
    ok: true,
    sessionID: `dry-${role}`,
    model,
    attempts: [{ model, ok: true }],
    text: `[dry-run] ${role} would run here.`,
    tokens: zeroTokens(),
    costUsd: 0,
    tracePath,
    startedAt,
    endedAt: Date.now(),
  };
}

const zeroTokens = (): AgentResult["tokens"] => ({ input: 0, output: 0, reasoning: 0, total: 0 });
const emptyStream = (): ParsedStream => ({ text: "", sessionID: null, tokens: zeroTokens(), costUsd: 0, sawError: true });

/**
 * Live-tails the per-attempt trace file while the worker is running so `opts.onText`
 * fires in real time (the file-redirect stdio stays untouched). A no-op when no
 * `onText` hook is provided. Returns a stop function that also flushes a final
 * complete line (handles a trailing newline-less JSON event at exit).
 *
 * Uses a single open file descriptor read from a tracked byte offset, so each
 * poll only fetches the bytes written since the last poll instead of rereading
 * the whole file.
 */
function startTailing(
  tracePath: string,
  startOffset: number,
  onText: ((chunk: string) => void) | undefined,
  onEvent: ((ev: Record<string, unknown>) => void) | undefined,
): () => void {
  if (!onText && !onEvent) return () => {};
  let fd: number | undefined;
  try {
    fd = openSync(tracePath, "r");
  } catch {
    // trace file not present yet; nothing to tail
    return () => {};
  }
  let offset = startOffset;
  let pending = "";
  const emit = (line: string): void => {
    if (!line.trim()) return;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      return; // partial or non-JSON noise
    }
    onEvent?.(ev);
    const part = ev.part ?? {};
    if (ev.type === "text" && typeof part.text === "string") onText?.(part.text);
  };
  const step = (): void => {
    let size: number;
    try {
      size = fstatSync(fd!).size;
    } catch {
      return; // fd closed or file gone
    }
    if (size <= offset) return;
    const length = size - offset;
    const buf = Buffer.allocUnsafe(length);
    let got = 0;
    try {
      got = readSync(fd!, buf, 0, length, offset);
    } catch {
      return;
    }
    if (got === 0) return;
    const chunk = pending + buf.subarray(0, got).toString("utf8");
    offset += got;
    const nl = chunk.lastIndexOf("\n");
    if (nl === -1) {
      pending = chunk;
      return;
    }
    const complete = chunk.slice(0, nl);
    pending = chunk.slice(nl + 1);
    for (const line of complete.split("\n")) emit(line);
  };
  const timer = setInterval(step, 150);
  return () => {
    clearInterval(timer);
    step();
    if (pending) {
      emit(pending);
      pending = "";
    }
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
  };
}

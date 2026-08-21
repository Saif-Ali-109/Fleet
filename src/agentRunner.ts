import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, fstatSync, mkdirSync, openSync, readSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { appendAuditEvent, ensureChain } from "./db/audit.ts";
import { pool } from "./db/client.ts";
import {
  backendDef,
  buildBackendArgs,
  buildBackendEnv,
  parseBackendTrace,
  resolveRolePrompt,
} from "./runner/backends.ts";
import type { AgentResult, Backend, Role, RolePolicy, RunContext } from "./types.ts";

// Shared with the CLI/SDK runtimes under src/runtime/.
export { buildBackendEnv, resolveRolePrompt } from "./runner/backends.ts";

export interface RunWorkerOpts {
  /** Reasoning-effort variant override (else policy.variant). */
  variant?: RolePolicy["variant"];
  /** Called for every assistant text chunk (for the live TUI). */
  onText?: (chunk: string) => void;
  /** Called for every opencode stream event (thinking, tool calls, results, etc.). */
  onEvent?: (ev: Record<string, unknown>) => void;
  /** Resume this CLI session instead of starting fresh (same backend, no model fallback). */
  resumeSessionID?: string;
}

export interface ParsedStream {
  text: string;
  sessionID: string | null;
  tokens: AgentResult["tokens"];
  costUsd: number;
  sawError: boolean;
  errorMsg?: string;
}

// Live worker child processes + user-abort flag (dashboard Stop button).
// killActiveWorkers() SIGTERMs every in-flight worker and latches the flag so
// runWorker fails fast instead of falling through the model fallback pool.
const liveChildren = new Set<ChildProcess>();
let abortRequested = false;

/** Kill every in-flight worker process and latch the abort flag. Returns the number killed. */
export function killActiveWorkers(): number {
  abortRequested = true;
  let n = 0;
  for (const child of [...liveChildren]) {
    try {
      child.kill("SIGTERM");
      n += 1;
    } catch {
      // already dead; close handler removes it
    }
  }
  return n;
}

/** Clear the abort latch (call when starting a new run/queue). */
export function resetWorkerAbort(): void {
  abortRequested = false;
}

/** Run one worker for `role` on the ctx backend (default opencode), trying `policy.model` then each fallback. */
export async function runWorker(
  role: Role,
  task: string,
  ctx: RunContext,
  policy: RolePolicy,
  opts: RunWorkerOpts = {},
): Promise<AgentResult> {
  const backend: Backend = ctx.backend ?? "opencode";
  const tracePath = join(ctx.tracesDir, `${role}.jsonl`);
  await mkdir(dirname(tracePath), { recursive: true });
  const startedAt = Date.now();

  if (ctx.dryRun) {
    return stubResult(role, policy.model, tracePath, startedAt);
  }

  const env = buildBackendEnv(backend, ctx);
  const rolePrompt = resolveRolePrompt(backend, role, ctx);
  const models = [policy.model, ...policy.fallbacks];
  let last: ParsedStream | null = null;
  let lastModel = policy.model;
  const attempts: NonNullable<AgentResult["attempts"]> = [];

  for (const model of models) {
    lastModel = model;
    if (abortRequested) {
      // User hit Stop: fail fast without spawning or falling back.
      attempts.push({ model, ok: false, error: "aborted by user" });
      continue;
    }
    const parsed = await spawnOnce(backend, role, task, ctx, model, policy, tracePath, opts, env, rolePrompt);
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
    abortRequested ? "aborted by user" : last?.errorMsg ?? "all models failed",
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
  backend: Backend = "opencode",
): string[] {
  return buildBackendArgs(backend, role, task, ctx, model, policy, opts, "").args;
}

export function spawnOnce(
  backend: Backend,
  role: Role,
  task: string,
  ctx: RunContext,
  model: string,
  policy: RolePolicy,
  tracePath: string,
  opts: RunWorkerOpts,
  env: NodeJS.ProcessEnv,
  rolePrompt: string,
): Promise<ParsedStream> {
  return new Promise((resolve) => {
    const { args, cwd } = buildBackendArgs(backend, role, task, ctx, model, policy, opts, rolePrompt);
    const binary = backendDef(backend).binary;
    const traceDir = dirname(tracePath);
    mkdirSync(traceDir, { recursive: true });
    const stderrPath = join(traceDir, `${role}.stderr.log`);
    const fdOut = openSync(tracePath, "a");
    const fdErr = openSync(stderrPath, "a");
    const startOffset = fstatSync(fdOut).size;

    // WORKER_TIMEOUT_MS kill switch: SIGTERM the worker after the timeout,
    // then SIGKILL after an optional grace period (WORKER_TIMEOUT_GRACE_MS).
    const timeoutMs = Number(process.env.WORKER_TIMEOUT_MS ?? "") || 0;
    const graceMs = Number(process.env.WORKER_TIMEOUT_GRACE_MS ?? "") || 1000;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;

    let settled = false;
    let stopTail = () => {};
    const settle = (s: ParsedStream) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(graceTimer);
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
      const child = spawn(binary, args, {
        cwd: cwd ?? ctx.rootDir,
        env,
        stdio: ["ignore", fdOut, fdErr],
      });
      liveChildren.add(child);
      child.on("close", () => liveChildren.delete(child));
      child.on("error", () => liveChildren.delete(child));
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

      if (timeoutMs > 0) {
        killTimer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          graceTimer = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              // already dead
            }
          }, graceMs);
        }, timeoutMs);
      }

      child.on("close", (code) => {
        const parsed = parseTrace(tracePath, opts, startOffset, backend);
        if (timedOut) {
          parsed.sawError = true;
          parsed.errorMsg = `timed out after ${timeoutMs}ms${parsed.errorMsg ? `: ${parsed.errorMsg}` : ""}`;
        } else if (code !== 0 && !parsed.sawError) {
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

/** Read back this attempt's trace from the trace file and build the parsed shape for `backend`. */
export function parseTrace(
  tracePath: string,
  opts: RunWorkerOpts,
  startOffset: number,
  backend: Backend = "opencode",
): ParsedStream {
  let raw: string;
  try {
    raw = readFileSync(tracePath, "utf8");
  } catch {
    return { text: "", sessionID: null, tokens: zeroTokens(), costUsd: 0, sawError: false };
  }
  const lastmsgPath = backend === "codex" ? tracePath.replace(/\.jsonl$/, ".lastmsg") : undefined;
  const t = parseBackendTrace(backend, raw, startOffset, { lastmsgPath });
  return {
    text: t.text,
    sessionID: t.sessionID,
    tokens: t.tokens,
    costUsd: t.costUsd,
    sawError: t.sawError,
    errorMsg: t.errorMsg,
  };
}

/** Last 400 chars of the per-attempt stderr log file, trimmed. */
export function readStderrTail(stderrPath: string): string {
  try {
    return readFileSync(stderrPath, "utf8").slice(-400).trim();
  } catch {
    return "";
  }
}

export function finalize(
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
    sawError: s.sawError,
    error,
    tracePath,
    startedAt,
    endedAt: Date.now(),
  };
}

export function stubResult(role: Role, model: string, tracePath: string, startedAt: number): AgentResult {
  return {
    role,
    ok: true,
    sessionID: `dry-${role}`,
    model,
    attempts: [{ model, ok: true }],
    text: `[dry-run] ${role} would run here.`,
    tokens: zeroTokens(),
    costUsd: 0,
    sawError: false,
    tracePath,
    startedAt,
    endedAt: Date.now(),
  };
}

export const zeroTokens = (): AgentResult["tokens"] => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cached: 0,
  cacheWrite: 0,
  total: 0,
});
export const emptyStream = (): ParsedStream => ({ text: "", sessionID: null, tokens: zeroTokens(), costUsd: 0, sawError: true });

/**
 * Bridge worker stream events into `opts.onEvent` so runtimes share one
 * forwarding path. The ctx/role/backend args keep the call site self-describing.
 */
export function makeEventBridge(
  ctx: RunContext,
  role: Role,
  backend: Backend,
  opts: RunWorkerOpts | undefined,
): (ev: Record<string, unknown>) => void {
  void ctx;
  void role;
  void backend;
  return (ev) => opts?.onEvent?.(ev);
}

/**
 * Fire-and-forget `wakeup` SOR write from a worker spawn. Non-fatal by
 * contract: any failure logs a warning and never aborts the run. No-op in
 * dry-run mode.
 */
export function emitWakeup(
  ctx: RunContext,
  backend: Backend,
  payload: Record<string, unknown>,
): Promise<void> {
  if (ctx.dryRun) return Promise.resolve();
  void (async () => {
    try {
      await ensureChain(pool);
      await appendAuditEvent(pool, {
        run_id: null,
        event_type: "wakeup",
        actor: "manager",
        backend,
        tool_name: null,
        tool_input: null,
        tool_output: null,
        payload,
        created_at: new Date().toISOString(),
      });
    } catch (err) {
      console.warn(`[sor] wakeup skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
  return Promise.resolve();
}

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

export function aggregateAgentResults(results: AgentResult[]): AgentResult {
  const first = results[0];
  if (!first) {
    throw new Error("aggregateAgentResults: no results to aggregate");
  }
  const last = results[results.length - 1] as AgentResult;
  const tokens: AgentResult["tokens"] = {
    input: 0,
    output: 0,
    reasoning: 0,
    cached: 0,
    cacheWrite: 0,
    total: 0,
  };
  let costUsd = 0;
  const attempts: NonNullable<AgentResult["attempts"]> = [];
  const text: string[] = [];
  let error: string | undefined;
  for (const r of results) {
    tokens.input += r.tokens.input;
    tokens.output += r.tokens.output;
    tokens.reasoning += r.tokens.reasoning;
    tokens.cached += r.tokens.cached;
    tokens.cacheWrite += r.tokens.cacheWrite;
    tokens.total += r.tokens.total;
    costUsd += r.costUsd ?? 0;
    if (r.attempts) attempts.push(...r.attempts);
    if (r.text.trim()) text.push(r.text);
    if (!error && r.error) error = r.error;
  }
  return {
    role: first.role,
    ok: results.every((r) => r.ok),
    sessionID: last.sessionID,
    model: last.model,
    attempts,
    text: text.join("\n"),
    tokens,
    costUsd,
    sawError: results.some((r) => r.sawError ?? false),
    error,
    tracePath: first.tracePath,
    startedAt: first.startedAt,
    endedAt: last.endedAt,
  };
}
import { spawn } from "node:child_process";
import { closeSync, fstatSync, mkdirSync, openSync, readSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  backendDef,
  buildBackendArgs,
  buildBackendEnv,
  parseBackendTrace,
  resolveRolePrompt,
} from "./runner/backends.js";
import { appendAuditEvent, ensureChain } from "./db/audit.js";
import { pool } from "./db/client.js";
import { normalizeTraceEvent } from "./sor/ingest.js";
import type { SorEvent } from "./sor/events.js";
import type { AgentResult, Backend, Role, RolePolicy, RunContext } from "./types.js";

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

  if (!ctx.dryRun) {
    try {
      await ensureChain(pool);
    } catch (err) {
      // The orchestrator also ensures the chain; a failure here must not abort the run.
      console.warn(`[sor] ensureChain failed for run ${ctx.runId}: ${(err as Error).message}`);
    }
  }

  if (ctx.dryRun) {
    return stubResult(role, policy.model, tracePath, startedAt);
  }

  const env = buildBackendEnv(backend, ctx);
  const rolePrompt = resolveRolePrompt(backend, role, ctx);
  const models = [policy.model, ...policy.fallbacks];
  const bridge = makeEventBridge(ctx, role, backend, opts);
  let last: ParsedStream | null = null;
  let lastModel = policy.model;
  const attempts: NonNullable<AgentResult["attempts"]> = [];

  for (const model of models) {
    lastModel = model;
    emitWakeup(ctx, backend, { kind: "spawn", role, model });
    const parsed = await spawnOnce(backend, role, task, ctx, model, policy, tracePath, opts, env, rolePrompt, bridge);
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
  backend: Backend = "opencode",
): string[] {
  return buildBackendArgs(backend, role, task, ctx, model, policy, opts, "").args;
}

function spawnOnce(
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
  onEvent: ((ev: Record<string, unknown>) => void) | undefined,
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
      const child = spawn(binary, args, {
        cwd: cwd ?? ctx.rootDir,
        env,
        stdio: ["ignore", fdOut, fdErr],
      });
      stopTail = startTailing(tracePath, startOffset, opts.onText, onEvent);

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
        const parsed = parseTrace(tracePath, opts, startOffset, backend);
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

/** Wrap the caller's onEvent so every trace event also ingests into the signed System of Record.
 *  Preserves opts.onEvent behavior; DB writes are fire-and-forget and skipped on dryRun. */
function makeEventBridge(
  ctx: RunContext,
  role: Role,
  backend: Backend,
  opts: RunWorkerOpts,
): (ev: Record<string, unknown>) => void {
  return (evRaw: Record<string, unknown>) => {
    opts.onEvent?.(evRaw);
    if (ctx.dryRun) return;
    const ev = normalizeTraceEvent(evRaw);
    if (ev) {
      ev.run_id = ctx.runId;
      if (!ev.actor || ev.actor === "system") ev.actor = role;
      appendAuditEvent(pool, ev).catch((err) =>
        console.warn(`[sor] trace event append failed (run=${ctx.runId}, role=${role}): ${(err as Error).message}`),
      );
    }
  };
}

/** Emit a spawn wakeup event for the system of record before an attempt starts. Fire-and-forget. */
function emitWakeup(
  ctx: RunContext,
  backend: Backend,
  payload: { kind: "spawn"; role: Role; model: string },
): void {
  if (ctx.dryRun) return;
  const event: SorEvent = {
    run_id: ctx.runId,
    event_type: "wakeup",
    actor: payload.role,
    backend,
    tool_name: null,
    tool_input: null,
    tool_output: null,
    payload: { kind: payload.kind, role: payload.role, model: payload.model },
    created_at: new Date().toISOString(),
  };
  appendAuditEvent(pool, event).catch((err) =>
    console.warn(`[sor] spawn wakeup append failed (run=${ctx.runId}, role=${payload.role}): ${(err as Error).message}`),
  );
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

const zeroTokens = (): AgentResult["tokens"] => ({ input: 0, output: 0, reasoning: 0, cached: 0, total: 0 });
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

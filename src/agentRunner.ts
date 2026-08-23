import { fork, type ChildProcess } from "node:child_process";
import { closeSync, fstatSync, mkdirSync, openSync, readSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appendAuditEvent, ensureChain } from "./db/audit.ts";
import { pool } from "./db/client.ts";
import { parseProviderTrace } from "./runner/providers.ts";
import { withProviderFallback } from "./providers/registry.ts";
import type { AgentResult, ProviderName, Role, RolePolicy, RunContext } from "./types.ts";

export interface RunWorkerOpts {
  /** Reasoning-effort variant override (else policy.variant). */
  variant?: RolePolicy["variant"];
  /** Called for every assistant text chunk (for the live TUI). */
  onText?: (chunk: string) => void;
  /** Called for every worker wire event (thinking, tool calls, results, etc.). */
  onEvent?: (ev: Record<string, unknown>) => void;
  /** Reviewer-findings injection only (SPEC §6); forwarded verbatim into the job ctx. */
  extraTask?: string;
}

export interface ParsedStream {
  text: string;
  sessionID: string | null;
  model?: string;
  tokens: AgentResult["tokens"];
  costUsd: number;
  sawError: boolean;
  errorMsg?: string;
}

// Live worker child processes + user-abort flag (dashboard Stop button).
// killActiveWorkers() SIGTERMs every in-flight worker and latches the flag so
// runWorker fails fast instead of falling through the provider fallback pool.
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

const DEFAULT_WORKER_ENTRY = fileURLToPath(new URL("./runtime/worker/main.ts", import.meta.url));

/**
 * Worker entry point. FLEET_WORKER_ENTRY is a PERMANENT TEST-ONLY seam: it is
 * never set by any production code path and exists solely so tests can fork a
 * stub worker program instead of the real runtime/worker/main.ts entry.
 */
function workerEntry(): string {
  return process.env.FLEET_WORKER_ENTRY
    ? resolve(process.env.FLEET_WORKER_ENTRY)
    : DEFAULT_WORKER_ENTRY;
}

/**
 * The ONE worker fork call site (SPEC §6): the `.ts` entry needs the tsx
 * loader (`--import tsx`, Node ≥22), stdout/stderr fds redirect straight into
 * the trace files so one stream IS trace capture AND event source, and stdin
 * is a pipe that receives ONE JSON job.
 */
function forkWorker(params: {
  entry: string;
  env: NodeJS.ProcessEnv;
  fdOut: number;
  fdErr: number;
}): ChildProcess {
  return fork(params.entry, {
    execPath: process.execPath,
    execArgv: [...process.execArgv, "--import", "tsx"],
    stdio: ["pipe", params.fdOut, params.fdErr, "ipc"],
    env: params.env,
  });
}

/** Run one worker for `role`, walking FLEET_PROVIDERS via withProviderFallback. */
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
    return stubResult(role, policy.model, tracePath, startedAt, ctx.provider ?? "gemini");
  }

  const walk = await withProviderFallback<ParsedStream>(role, async (provider) => {
    if (abortRequested) {
      // User hit Stop: fail fast without forking or falling back.
      return { model: policy.model, ok: false, error: "aborted by user" };
    }
    const parsed = await spawnOnce(provider, role, task, ctx, opts.extraTask, tracePath, opts);
    const ok = !parsed.sawError && !abortRequested && parsed.text.trim().length > 0;
    return { model: parsed.model ?? policy.model, ok, value: parsed, error: parsed.errorMsg };
  });

  const attempts: NonNullable<AgentResult["attempts"]> = walk.attempts.map((a) => ({
    model: a.model,
    ok: a.ok,
    ...(a.error !== undefined ? { error: a.error } : {}),
    ...(a.provider !== null ? { provider: a.provider } : {}),
  }));

  return finalize(
    role,
    walk.ok ? walk.model : attempts[attempts.length - 1]?.model ?? walk.model,
    walk.value ?? emptyStream(),
    tracePath,
    startedAt,
    walk.ok,
    walk.ok ? undefined : walk.error ?? "all providers failed",
    attempts,
    walk.provider ?? ctx.provider ?? "gemini",
  );
}

/** Fork one worker attempt for `provider` and parse its trace slice into a ParsedStream. */
export function spawnOnce(
  provider: ProviderName,
  role: Role,
  task: string,
  ctx: RunContext,
  extraTask: string | undefined,
  tracePath: string,
  opts: RunWorkerOpts,
): Promise<ParsedStream> {
  return new Promise((resolve) => {
    const traceDir = dirname(tracePath);
    mkdirSync(traceDir, { recursive: true });
    const stderrPath = join(traceDir, `${role}.stderr.log`);
    const eventsDir = join(ctx.runDir, "events");
    try {
      mkdirSync(eventsDir, { recursive: true });
    } catch {
      // non-fatal: the worker creates it lazily if needed
    }
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
      const child = forkWorker({
        entry: workerEntry(),
        env: {
          ...process.env,
          SOR_PROVIDER: provider,
          SOR_EVENT_DIR: eventsDir,
          // Pin the fleet to this one candidate so the worker's own
          // resolveProviderModel lands on exactly the walked provider.
          FLEET_PROVIDERS: provider,
        },
        fdOut,
        fdErr,
      });
      liveChildren.add(child);
      child.on("close", () => liveChildren.delete(child));
      child.on("error", () => liveChildren.delete(child));
      stopTail = startTailing(tracePath, startOffset, opts.onText, opts.onEvent);

      const job = {
        role,
        task,
        ctx: {
          rootDir: ctx.rootDir,
          worktreeDir: ctx.worktreeDir,
          tracesDir: ctx.tracesDir,
          runDir: ctx.runDir,
          dryRun: ctx.dryRun,
          ...(extraTask !== undefined ? { extraTask } : {}),
        },
      };
      if (child.stdin) {
        child.stdin.on("error", () => {}); // EPIPE when the child dies before reading the job
        child.stdin.end(JSON.stringify(job) + "\n");
      }

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
        const parsed = parseTrace(tracePath, opts, startOffset, provider);
        if (timedOut) {
          parsed.sawError = true;
          parsed.errorMsg = `timed out after ${timeoutMs}ms${parsed.errorMsg ? `: ${parsed.errorMsg}` : ""}`;
        } else if (abortRequested) {
          parsed.sawError = true;
          parsed.errorMsg = "aborted by user";
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

/** Read back this attempt's trace from the trace file and build the parsed shape for `provider`. */
export function parseTrace(
  tracePath: string,
  opts: RunWorkerOpts,
  startOffset: number,
  provider: ProviderName = "gemini",
): ParsedStream {
  void opts;
  let raw: string;
  try {
    raw = readFileSync(tracePath, "utf8");
  } catch {
    return { text: "", sessionID: null, tokens: zeroTokens(), costUsd: 0, sawError: false };
  }
  const t = parseProviderTrace(provider, raw, startOffset);
  return {
    text: t.text,
    sessionID: t.sessionID,
    model: t.model ?? undefined,
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
  provider: ProviderName = "gemini",
): AgentResult {
  return {
    role,
    ok,
    sessionID: s.sessionID,
    model,
    provider,
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

export function stubResult(
  role: Role,
  model: string,
  tracePath: string,
  startedAt: number,
  provider: ProviderName = "gemini",
): AgentResult {
  return {
    role,
    ok: true,
    sessionID: `dry-${role}`,
    model,
    provider,
    attempts: [{ model, ok: true, provider }],
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
 * forwarding path. The ctx/role/provider args keep the call site self-describing.
 */
export function makeEventBridge(
  ctx: RunContext,
  role: Role,
  provider: ProviderName,
  opts: RunWorkerOpts | undefined,
): (ev: Record<string, unknown>) => void {
  void ctx;
  void role;
  void provider;
  return (ev) => opts?.onEvent?.(ev);
}

/**
 * Fire-and-forget `wakeup` SOR write from a worker spawn. Non-fatal by
 * contract: any failure logs a warning and never aborts the run. No-op in
 * dry-run mode.
 */
export function emitWakeup(
  ctx: RunContext,
  provider: ProviderName,
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
        backend: provider,
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
    if (ev.t === "text" && typeof part.text === "string") onText?.(part.text);
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
    provider: last.provider, // Preserve provider from last result
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

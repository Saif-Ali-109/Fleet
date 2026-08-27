import { appendFile, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Pool } from "pg";
import { appendAuditEvent, ensureChain } from "../db/audit.ts";
import { pool as sharedPool } from "../db/client.ts";
import type { SorEvent } from "../sor/events.ts";
import {
  TOOL_INPUT_CAP,
  TOOL_OUTPUT_CAP,
  normalizeEvent,
  truncateValue,
} from "../sor/events.ts";

export interface SorEmitSink {
  toolCall(callId: string, toolName: string, input: unknown): void;
  toolResult(
    callId: string,
    toolName: string,
    input: unknown,
    output: unknown,
    ok: boolean,
    ms: number,
  ): void;
}

export interface SorEmitOptions {
  runDir: string;
  role: string;
  provider: string;
  model: string;
  sessionId: string;
  eventsDir?: string;
  runId?: string;
  pool?: Pool | null;
}

export interface SorEmitContext {
  role: string;
  provider: string;
  model: string;
  sessionId: string;
  runId: string;
}

export interface SorToolEmission {
  record: Record<string, unknown>;
  event: SorEvent;
}

export type SorPhase = "before" | "after";

/**
 * Module-level promise chain serializing events.jsonl appends within this
 * process: each append is chained onto the previous one so file order always
 * matches call-site order (an `after` row must never precede its own `before`).
 * Failures are swallowed inside the chain so it can never reject.
 */
let jsonlWriteQueue: Promise<void> = Promise.resolve();
function enqueueJsonlAppend(eventsDir: string, line: string): void {
  jsonlWriteQueue = jsonlWriteQueue.then(async () => {
    try {
      await mkdir(eventsDir, { recursive: true });
      await appendFile(join(eventsDir, "events.jsonl"), line, "utf8");
    } catch (err) {
      console.warn(
        `[sor] jsonl append skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
}

/** Deep-sorts object keys so JSON.stringify emits a canonical ordering. */
export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** Single-line key-sorted JSON serialization matching the hook-era events.jsonl format. */
export function serializeSorRecord(record: Record<string, unknown>): string {
  return JSON.stringify(sortKeys(record));
}

/**
 * Build ONE tool_call emission in the EXACT hook-era record shape:
 * top-level {actor, backend, created_at, event_type, payload, run_id} with
 * payload {call_id, phase, session_id, tool_input, tool_name[, tool_output]},
 * plus the full SorEvent used for the DB hash chain.
 */
export function buildToolEmission(
  ctx: SorEmitContext,
  phase: SorPhase,
  callId: string,
  toolName: string,
  input: unknown,
  output?: unknown,
  createdAt: string = new Date().toISOString(),
): SorToolEmission {
  const payload: Record<string, unknown> = {
    call_id: callId,
    phase,
    session_id: ctx.sessionId,
    tool_input: input ?? null,
    tool_name: toolName,
  };
  if (phase === "after") {
    payload.tool_output = output ?? null;
  }

  const record: Record<string, unknown> = {
    actor: "system",
    backend: ctx.provider,
    created_at: createdAt,
    event_type: "tool_call",
    payload,
    run_id: ctx.runId,
  };

  const event = normalizeEvent({
    run_id: ctx.runId,
    event_type: "tool_call",
    actor: "system",
    backend: ctx.provider,
    tool_name: toolName,
    tool_input: input === undefined ? null : truncateValue(input, TOOL_INPUT_CAP),
    tool_output:
      phase === "after" && output !== undefined ? truncateValue(output, TOOL_OUTPUT_CAP) : null,
    payload,
    created_at: createdAt,
  });

  return { record, event };
}

/**
 * SOR emitter sink for the worker loop (D12): every tool_call/tool_result
 * appends a hook-era-shaped JSONL line to <eventsDir>/events.jsonl AND a
 * chain-signed event to the DB via ensureChain/appendAuditEvent. ALL writes are
 * NON-FATAL by contract — failures warn and never abort the run.
 */
export function createSorEmitSink(opts: SorEmitOptions): SorEmitSink {
  const eventsDir = opts.eventsDir ?? join(opts.runDir, "events");
  const ctx: SorEmitContext = {
    role: opts.role,
    provider: opts.provider,
    model: opts.model,
    sessionId: opts.sessionId,
    runId: opts.runId ?? basename(opts.runDir),
  };
  const dbPool: Pool | null =
    "pool" in opts ? (opts.pool ?? null) : process.env.DATABASE_URL ? sharedPool : null;

  let chainReady: Promise<void> | null = null;
  const ensureChainOnce = (): Promise<void> => {
    chainReady ??= ensureChain(dbPool as Pool);
    return chainReady;
  };

  const emit = (
    phase: SorPhase,
    callId: string,
    toolName: string,
    input: unknown,
    output?: unknown,
  ): void => {
    let emission: SorToolEmission;
    try {
      emission = buildToolEmission(ctx, phase, callId, toolName, input, output);
    } catch (err) {
      console.warn(
        `[sor] ${phase} record skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    const line = serializeSorRecord(emission.record) + "\n";
    enqueueJsonlAppend(eventsDir, line);

    if (!dbPool) return;
    void (async () => {
      try {
        await ensureChainOnce();
        await appendAuditEvent(dbPool, emission.event);
      } catch (err) {
        chainReady = null;
        console.warn(
          `[sor] db append skipped: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();
  };

  return {
    toolCall(callId, toolName, input): void {
      emit("before", callId, toolName, input);
    },
    toolResult(callId, toolName, input, output, _ok, _ms): void {
      emit("after", callId, toolName, input, output);
    },
  };
}

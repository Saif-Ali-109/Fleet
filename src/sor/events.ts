// Signed System of Record event types, normalization, and truncation.

export type SorEventType = "tool_call" | "wakeup" | "phase" | "registry_sync" | "finalize";

export interface SorEvent {
  run_id: string | null;
  event_type: SorEventType;
  actor: string; // role | 'manager' | 'daemon' | 'system'
  backend: string | null; // 'gemini' | 'openrouter' | 'ollama' | legacy 'opencode' | 'claude' | 'codex' (kept for historical verification) | null
  tool_name: string | null;
  tool_input: unknown | null;
  tool_output: unknown | null;
  payload: Record<string, unknown>;
  created_at: string; // ISO 8601 string
}

export const TOOL_INPUT_CAP = 20000; // max chars before truncation
export const TOOL_OUTPUT_CAP = 20000;

const VALID_TYPES: readonly SorEventType[] = ["tool_call", "wakeup", "phase", "registry_sync", "finalize"];
const VALID_BACKENDS: readonly string[] = ["opencode", "claude", "codex", "gemini", "openrouter", "ollama"]; // legacy 'opencode' | 'claude' | 'codex' kept for historical verification

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Strings truncated to `cap` chars, nested objects/arrays recursively truncated to `cap` total
 *  chars (budget is consumed by characters across the whole structure), other primitives pass through. */
export function truncateValue(v: unknown, cap: number): unknown {
  return truncateRec(v, { remaining: cap });
}

function truncateRec(v: unknown, budget: { remaining: number }): unknown {
  if (typeof v === "string") {
    if (v.length > budget.remaining) {
      const sliced = v.slice(0, budget.remaining);
      budget.remaining = 0;
      return sliced;
    }
    budget.remaining -= v.length;
    return v;
  }
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    for (const el of v) {
      if (budget.remaining <= 0) break;
      out.push(truncateRec(el, budget));
    }
    return out;
  }
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v)) {
      if (budget.remaining <= 0) break;
      out[key] = truncateRec(v[key], budget);
    }
    return out;
  }
  return v;
}

/** Validate an unknown value into a `SorEvent`, coercing `created_at` to ISO and `run_id` to string|null. */
export function normalizeEvent(raw: unknown): SorEvent {
  if (!isPlainObject(raw)) {
    throw new Error(`normalizeEvent: expected an object event, got ${typeof raw}`);
  }

  const eventType = raw.event_type;
  if (typeof eventType !== "string" || !(VALID_TYPES as readonly unknown[]).includes(eventType)) {
    throw new Error(
      `normalizeEvent: invalid or missing event_type (expected one of ${VALID_TYPES.join(", ")}), got ${JSON.stringify(eventType)}`
    );
  }

  const actor = raw.actor;
  if (typeof actor !== "string" || actor.trim().length === 0) {
    throw new Error(`normalizeEvent: invalid or missing actor, got ${JSON.stringify(actor)}`);
  }

  const backend = raw.backend === undefined || raw.backend === null ? null : raw.backend;
  if (backend !== null && !(VALID_BACKENDS as readonly unknown[]).includes(backend)) {
    throw new Error(`normalizeEvent: invalid backend (expected one of ${VALID_BACKENDS.join(", ")} or null), got ${JSON.stringify(backend)}`);
  }

  let payload: Record<string, unknown>;
  if (raw.payload === undefined || raw.payload === null) {
    payload = {};
  } else if (isPlainObject(raw.payload)) {
    payload = raw.payload;
  } else {
    throw new Error(`normalizeEvent: payload must be an object, got ${JSON.stringify(raw.payload)}`);
  }

  let runId: string | null = null;
  if (raw.run_id !== undefined && raw.run_id !== null) {
    runId = typeof raw.run_id === "string" ? raw.run_id : String(raw.run_id);
  }

  let toolName: string | null = null;
  if (raw.tool_name !== undefined && raw.tool_name !== null) {
    toolName = typeof raw.tool_name === "string" ? raw.tool_name : String(raw.tool_name);
  }

  let createdAt: string;
  try {
    const ts = raw.created_at === undefined || raw.created_at === null ? new Date() : new Date(raw.created_at as string | number | Date);
    if (Number.isNaN(ts.getTime())) throw new Error("NaN timestamp");
    createdAt = ts.toISOString();
  } catch {
    throw new Error(`normalizeEvent: invalid created_at, got ${JSON.stringify(raw.created_at)}`);
  }

  return {
    run_id: runId,
    event_type: eventType as SorEventType,
    actor,
    backend: backend as string | null,
    tool_name: toolName,
    tool_input: raw.tool_input === undefined ? null : raw.tool_input,
    tool_output: raw.tool_output === undefined ? null : raw.tool_output,
    payload,
    created_at: createdAt,
  };
}

/** Plain column object for DB inserts (run_id, event_type, actor, backend, tool_name, tool_input, tool_output, payload, created_at). */
export function eventToRecord(e: SorEvent): Record<string, unknown> {
  return {
    run_id: e.run_id,
    event_type: e.event_type,
    actor: e.actor,
    backend: e.backend,
    tool_name: e.tool_name,
    tool_input: e.tool_input,
    tool_output: e.tool_output,
    payload: e.payload,
    created_at: e.created_at,
  };
}
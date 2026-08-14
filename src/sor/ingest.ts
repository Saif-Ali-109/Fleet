// Ingestion for the signed System of Record: converts raw hook lines and
// opencode NDJSON trace events into normalized SorEvent objects (no signing —
// that happens later, in the DB layer).

import { readFileSync } from "node:fs";
import type { SorEvent } from "./events.js";
import {
  TOOL_INPUT_CAP,
  TOOL_OUTPUT_CAP,
  normalizeEvent,
  truncateValue,
} from "./events.js";

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const VALID_BACKENDS: readonly string[] = ["opencode", "claude", "codex"];

/** Best-effort backend from the event, else defaulting to "opencode" (trace events are opencode NDJSON). */
function backendOf(ev: Record<string, unknown>): string {
  if (typeof ev.backend === "string" && (VALID_BACKENDS as readonly unknown[]).includes(ev.backend)) {
    return ev.backend;
  }
  return "opencode";
}

/** created_at from an explicit ISO field or an epoch-ms `timestamp`, else now. */
function createdAtOf(ev: Record<string, unknown>): string | number | Date {
  if (typeof ev.created_at === "string") return ev.created_at;
  if (typeof ev.timestamp === "number") return ev.timestamp;
  return new Date();
}

/**
 * Parse ONE JSONL line from a hook-written event file ($SOR_EVENT_DIR/events.jsonl).
 * Returns null for blank/invalid lines (never throws). The line is a JSON object with
 * keys like event_type, actor, backend, tool_name, tool_input, tool_output, payload,
 * run_id, created_at.
 */
export function normalizeHookLine(line: string): SorEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isPlainObject(raw)) return null;

  try {
    return normalizeEvent({
      ...raw,
      tool_input: raw.tool_input === undefined ? null : truncateValue(raw.tool_input, TOOL_INPUT_CAP),
      tool_output: raw.tool_output === undefined ? null : truncateValue(raw.tool_output, TOOL_OUTPUT_CAP),
    });
  } catch {
    return null;
  }
}

/** A tool call found inside a "message" trace event, or null when the message has none. */
interface ToolCall {
  tool: string | null;
  input: unknown;
  output: unknown;
}

function toolCallFrom(ev: Record<string, unknown>): ToolCall | null {
  const part = isPlainObject(ev.part) ? ev.part : null;
  const message = isPlainObject(ev.message) ? ev.message : null;

  if (part && (part.type === "tool_call" || part.type === "tool" || typeof part.tool === "string")) {
    const state = isPlainObject(part.state) ? part.state : null;
    return {
      tool: typeof part.tool === "string" ? part.tool : typeof part.tool_name === "string" ? part.tool_name : null,
      input: state && state.input !== undefined ? state.input : part.input ?? null,
      output: state && state.output !== undefined ? state.output : null,
    };
  }

  if (message) {
    if (typeof message.tool === "string") {
      return { tool: message.tool, input: message.input ?? null, output: message.output ?? null };
    }
    if (Array.isArray(message.toolCalls)) {
      const first = message.toolCalls[0];
      if (isPlainObject(first)) {
        const state = isPlainObject(first.state) ? first.state : null;
        return {
          tool: typeof first.tool === "string" ? first.tool : null,
          input: state && state.input !== undefined ? state.input : first.input ?? null,
          output: state && state.output !== undefined ? state.output : null,
        };
      }
    }
  }

  return null;
}

/**
 * Convert an opencode NDJSON trace event (the object passed to agentRunner onEvent) into
 * a SorEvent, or null if not mappable. Never throws. tool_input/tool_output are truncated
 * with truncateValue to TOOL_INPUT_CAP/TOOL_OUTPUT_CAP.
 */
export function normalizeTraceEvent(ev: unknown): SorEvent | null {
  if (!isPlainObject(ev)) return null;
  const type = ev.type;

  try {
    if (type === "step_finish") {
      const part = isPlainObject(ev.part) ? ev.part : {};
      const tokens = isPlainObject(part.tokens) ? part.tokens : isPlainObject(ev.tokens) ? ev.tokens : {};
      return normalizeEvent({
        event_type: "wakeup",
        actor: typeof ev.actor === "string" ? ev.actor : "system",
        backend: backendOf(ev),
        tool_name: null,
        tool_input: null,
        tool_output: null,
        payload: { kind: "step_finish", tokens },
        run_id: typeof ev.run_id === "string" ? ev.run_id : null,
        created_at: createdAtOf(ev),
      });
    }

    if (type === "message") {
      const call = toolCallFrom(ev);
      if (call && typeof call.tool === "string" && call.tool.length > 0) {
        const backend = backendOf(ev);
        return normalizeEvent({
          event_type: "tool_call",
          actor: backend,
          backend,
          tool_name: call.tool,
          tool_input: call.input === null ? null : truncateValue(call.input, TOOL_INPUT_CAP),
          tool_output: call.output === null ? null : truncateValue(call.output, TOOL_OUTPUT_CAP),
          payload: {},
          run_id: typeof ev.run_id === "string" ? ev.run_id : null,
          created_at: createdAtOf(ev),
        });
      }
      return null;
    }

    if (type === "session.idle") {
      return normalizeEvent({
        event_type: "wakeup",
        actor: typeof ev.actor === "string" ? ev.actor : "system",
        backend: backendOf(ev),
        tool_name: null,
        tool_input: null,
        tool_output: null,
        payload: { kind: "session.idle" },
        run_id: typeof ev.run_id === "string" ? ev.run_id : null,
        created_at: createdAtOf(ev),
      });
    }

    return null;
  } catch {
    return null;
  }
}

/** Read a whole event file (path) and return all parseable events in file order. */
export function readEventFile(filePath: string): SorEvent[] {
  let body: string;
  try {
    body = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }

  const events: SorEvent[] = [];
  for (const line of body.split("\n")) {
    const event = normalizeHookLine(line);
    if (event) events.push(event);
  }
  return events;
}
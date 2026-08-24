import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeHookLine,
  normalizeTraceEvent,
  readEventFile,
} from "../ingest.ts";
import { TOOL_INPUT_CAP, type SorEvent } from "../events.ts";

function makeHookLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event_type: "tool_call",
    actor: "system",
    backend: "opencode",
    tool_name: "bash",
    tool_input: { command: "ls" },
    tool_output: { ok: true },
    payload: { phase: "test" },
    run_id: "run-123",
    created_at: "2026-08-13T12:00:00.000Z",
    ...overrides,
  });
}

describe("normalizeHookLine", () => {
  it("parses a valid hook JSON line into a SorEvent", () => {
    const line = makeHookLine();
    const ev = normalizeHookLine(line);
    expect(ev).not.toBeNull();
    expect(ev?.event_type).toBe("tool_call");
    expect(ev?.actor).toBe("system");
    expect(ev?.backend).toBe("opencode");
    expect(ev?.tool_name).toBe("bash");
    expect(ev?.tool_input).toEqual({ command: "ls" });
    expect(ev?.tool_output).toEqual({ ok: true });
    expect(ev?.run_id).toBe("run-123");
    expect(ev?.created_at).toBe("2026-08-13T12:00:00.000Z");
  });

  it("returns null for garbage / non-JSON", () => {
    expect(normalizeHookLine("not json {")).toBeNull();
  });

  it("returns null for blank lines and whitespace", () => {
    expect(normalizeHookLine("")).toBeNull();
    expect(normalizeHookLine("   ")).toBeNull();
    expect(normalizeHookLine("\n")).toBeNull();
  });

  it("returns null for a line with an invalid event_type (instead of throwing)", () => {
    expect(normalizeHookLine(makeHookLine({ event_type: "bogus" }))).toBeNull();
  });
});

describe("normalizeTraceEvent", () => {
  it("maps a step_finish-ish object to a wakeup event with tokens payload", () => {
    const ev = normalizeTraceEvent({
      type: "step_finish",
      sessionID: "sess-1",
      part: {
        tokens: { input: 10, output: 5, reasoning: 2, total: 17 },
        cost: 0.01,
      },
    });
    expect(ev).not.toBeNull();
    expect(ev?.event_type).toBe("wakeup");
    expect(ev?.payload.kind).toBe("step_finish");
    expect(ev?.payload.tokens).toEqual({ input: 10, output: 5, reasoning: 2, total: 17 });
    expect(ev?.tool_name).toBeNull();
  });

  it("maps a tool_call-ish message object to a tool_call event", () => {
    const ev = normalizeTraceEvent({
      type: "message",
      sessionID: "sess-2",
      part: {
        type: "tool_call",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "ls -la" },
          output: "total 4",
        },
      },
    });
    expect(ev).not.toBeNull();
    expect(ev?.event_type).toBe("tool_call");
    expect(ev?.actor).toBe("gemini");
    expect(ev?.backend).toBe("gemini");
    expect(ev?.tool_name).toBe("bash");
    expect(ev?.tool_input).toEqual({ command: "ls -la" });
    expect(ev?.tool_output).toEqual("total 4");
  });

  it("maps a message with toolCalls array to a tool_call event", () => {
    const ev = normalizeTraceEvent({
      type: "message",
      message: {
        role: "assistant",
        toolCalls: [{ tool: "read", input: { filePath: "a.ts" }, state: { output: "content" } }],
      },
    });
    expect(ev?.event_type).toBe("tool_call");
    expect(ev?.tool_name).toBe("read");
    expect(ev?.tool_input).toEqual({ filePath: "a.ts" });
    expect(ev?.tool_output).toEqual("content");
  });

  it("maps a session.idle object to a wakeup event", () => {
    const ev = normalizeTraceEvent({ type: "session.idle", sessionID: "sess-3" });
    expect(ev).not.toBeNull();
    expect(ev?.event_type).toBe("wakeup");
    expect(ev?.payload).toEqual({ kind: "session.idle" });
  });

  it("returns null for unrecognized event types", () => {
    expect(normalizeTraceEvent({ type: "text", part: { text: "hello" } })).toBeNull();
    expect(normalizeTraceEvent({ type: "step_start" })).toBeNull();
    expect(normalizeTraceEvent({ type: "error", part: { error: "boom" } })).toBeNull();
  });

  it("returns null for non-objects and never throws", () => {
    expect(normalizeTraceEvent(null)).toBeNull();
    expect(normalizeTraceEvent("nope")).toBeNull();
    expect(normalizeTraceEvent(42)).toBeNull();
    expect(normalizeTraceEvent(undefined)).toBeNull();
  });

  it("truncates long tool_input against TOOL_INPUT_CAP", () => {
    const long = "x".repeat(TOOL_INPUT_CAP + 500);
    const ev = normalizeTraceEvent({
      type: "message",
      part: { type: "tool_call", tool: "bash", state: { status: "completed", input: long, output: "ok" } },
    });
    expect(ev?.tool_name).toBe("bash");
    expect(typeof ev?.tool_input).toBe("string");
    expect((ev?.tool_input as string).length).toBe(TOOL_INPUT_CAP);
  });
});

describe("readEventFile", () => {
  it("returns parseable events in file order from a temp file", () => {
    const dir = mkdtempSync(join(tmpdir(), "sor-ingest-"));
    const file = join(dir, "events.jsonl");
    try {
      writeFileSync(
        file,
        [
          makeHookLine({ event_type: "wakeup", payload: { kind: "session.idle" } }),
          "this line is garbage",
          makeHookLine({ tool_name: "read", tool_input: { filePath: "a.ts" } }),
          "",
          makeHookLine({ event_type: "phase", actor: "manager", payload: { phase: "analyze" } }),
        ].join("\n"),
        "utf8",
      );
      const events: SorEvent[] = readEventFile(file);
      expect(events).toHaveLength(3);
      expect(events[0]?.event_type).toBe("wakeup");
      expect(events[1]?.tool_name).toBe("read");
      expect(events[2]?.event_type).toBe("phase");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns [] for a missing file", () => {
    expect(readEventFile("/no/such/events.jsonl")).toEqual([]);
  });
});
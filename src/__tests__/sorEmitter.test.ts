import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type OpenAI from "openai";
import type { Pool } from "pg";
import { runAgent, type WireEvent } from "../fleet/loop.ts";
import {
  buildToolEmission,
  createSorEmitSink,
  serializeSorRecord,
  sortKeys,
  type SorEmitSink,
} from "../fleet/sorEmit.ts";
import { normalizeHookLine } from "../sor/ingest.ts";
import { GENESIS_HASH, canonicalJson, computeHash, signEvent } from "../sor/signer.ts";
import type { SorEvent } from "../sor/events.ts";
import { eventToRecord } from "../sor/events.ts";
import { normalizeEvent } from "../sor/events.ts";
import { buildRegistry } from "../fleet/tools/registry.ts";
import type { FleetAgentDef, ToolName } from "../fleet/types.ts";

const FIXTURE_PATH = join(import.meta.dirname, "fixtures/sor/historical-events.jsonl");

function fixtureLines(): Record<string, unknown>[] {
  return readFileSync(FIXTURE_PATH, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const ctx = {
  role: "analyzer",
  provider: "gemini",
  model: "gemini-test-model",
  sessionId: "ses_ff0fdf170ffe5JqtFX2rE6p15q",
  runId: "2026-08-17T09-15-48-451Z",
};

type MockResponse = Record<string, unknown>;

function resp(message: MockResponse): MockResponse {
  return {
    id: "chatcmpl-x",
    object: "chat.completion",
    choices: [{ index: 0, message, finish_reason: "stop" }],
    usage: {},
  };
}

function defWith(tools: string[]): FleetAgentDef {
  return {
    name: "coder",
    systemPrompt: "",
    tools: tools as unknown as ToolName[],
    mcpAllow: [],
    skillsDir: "skills/coder",
  };
}

let tmp = "";
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sor-emit-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

describe("SOR emitter parity with historical hook records", () => {
  it("tool_call before record has IDENTICAL field set AND key ordering vs the historical fixture", () => {
    const lines = fixtureLines();
    const hist = lines.find(
      (l) =>
        l.event_type === "tool_call" &&
        (l.payload as Record<string, unknown>).phase === "before",
    ) as Record<string, unknown>;
    expect(hist).toBeDefined();
    const histPayload = hist.payload as Record<string, unknown>;

    const emission = buildToolEmission(
      ctx,
      "before",
      String(histPayload.call_id),
      String(histPayload.tool_name),
      histPayload.tool_input,
      undefined,
      String(hist.created_at),
    );

    expect(Object.keys(emission.record)).toEqual(Object.keys(hist));
    expect(Object.keys(emission.record.payload as Record<string, unknown>)).toEqual(
      Object.keys(histPayload),
    );

    const serialized = serializeSorRecord(emission.record);
    expect(serialized).toBe(JSON.stringify(sortKeys(emission.record)));
    expect(serialized.indexOf('{"actor"')).toBe(0);
    expect(JSON.parse(serialized)).toEqual(sortKeys(emission.record));
  });

  it("tool_call after record has IDENTICAL field set AND key ordering vs the historical fixture", () => {
    const lines = fixtureLines();
    const hist = lines.find(
      (l) =>
        l.event_type === "tool_call" &&
        (l.payload as Record<string, unknown>).phase === "after",
    ) as Record<string, unknown>;
    expect(hist).toBeDefined();
    const histPayload = hist.payload as Record<string, unknown>;

    const emission = buildToolEmission(
      { ...ctx, runId: String(hist.run_id) },
      "after",
      String(histPayload.call_id),
      String(histPayload.tool_name),
      histPayload.tool_input,
      histPayload.tool_output,
      String(hist.created_at),
    );

    expect(Object.keys(emission.record)).toEqual(Object.keys(hist));
    expect(Object.keys(emission.record.payload as Record<string, unknown>)).toEqual(
      Object.keys(histPayload),
    );
    expect((emission.record.payload as Record<string, unknown>).phase).toBe("after");
    expect(emission.record.backend).toBe(ctx.provider);

    expect(serializeSorRecord(emission.record)).toBe(
      serializeSorRecord({
        actor: hist.actor,
        backend: ctx.provider,
        created_at: hist.created_at,
        event_type: hist.event_type,
        payload: sortKeys(histPayload),
        run_id: hist.run_id,
      }),
    );
  });

  it("new records carry the provider name in backend while historical rows keep legacy strings", () => {
    const emission = buildToolEmission(ctx, "before", "call_x", "bash", {}, undefined);
    expect(emission.event.backend).toBe("gemini");
    const legacy = fixtureLines().every((l) => l.backend === "opencode");
    expect(legacy).toBe(true);
  });
});

describe("historical fixture replay through pure chain logic", () => {
  it("every tool_call line normalizes and hashes onto one unbroken chain", () => {
    const lines = readFileSync(FIXTURE_PATH, "utf8").split("\n").filter((l) => l.trim());
    const events: SorEvent[] = [];
    for (const line of lines) {
      const ev = normalizeHookLine(line);
      if (ev) events.push(ev);
    }
    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(events.length).toBe(3);

    const key = "replay-test-key";
    let prevHash = GENESIS_HASH;
    for (const ev of events) {
      const hash = signEvent(key, prevHash, ev);
      const manual = computeHash(key, prevHash, canonicalJson(eventToRecord(ev)));
      expect(hash).toBe(manual);
      const recomputed = signEvent(key, prevHash, ev);
      expect(recomputed).toBe(hash);
      prevHash = hash;
    }
    expect(prevHash).not.toBe(GENESIS_HASH);
  });

  it("normalizeHookLine skips the session.created line without throwing", () => {
    const lines = fixtureLines();
    const created = lines.find((l) => l.event_type === "session.created") as Record<
      string,
      unknown
    >;
    expect(created).toBeDefined();
    expect(normalizeHookLine(JSON.stringify(created))).toBeNull();
  });
});

describe("normalizeEvent backend acceptance", () => {
  const base = {
    event_type: "tool_call",
    actor: "system",
    payload: {},
  };

  it("accepts new provider backends gemini/openrouter/ollama", () => {
    for (const backend of ["gemini", "openrouter", "ollama"]) {
      const ev = normalizeEvent({ ...base, backend, created_at: "2026-08-23T00:00:00Z" });
      expect(ev.backend).toBe(backend);
    }
  });

  it("still accepts legacy backends opencode/claude/codex and null", () => {
    for (const backend of ["opencode", "claude", "codex"]) {
      const ev = normalizeEvent({ ...base, backend, created_at: "2026-08-23T00:00:00Z" });
      expect(ev.backend).toBe(backend);
    }
    expect(normalizeEvent({ ...base, created_at: "2026-08-23T00:00:00Z" }).backend).toBeNull();
  });

  it("rejects garbage backends", () => {
    expect(() =>
      normalizeEvent({ ...base, backend: "skynet", created_at: "2026-08-23T00:00:00Z" }),
    ).toThrow(/invalid backend/);
  });
});

describe("non-fatal SOR writes", () => {
  it("jsonl write failure into an unwritable path warns and never throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const filePath = join(tmp, "blocker.txt");
    writeFileSync(filePath, "not a dir");

    const sink = createSorEmitSink({
      runDir: tmp,
      role: "coder",
      provider: "gemini",
      model: "m",
      sessionId: "s1",
      eventsDir: filePath,
      pool: null,
    });

    expect(() => sink.toolCall("call_1", "bash", {})).not.toThrow();
    await new Promise((r) => setTimeout(r, 30));
    expect(warn).toHaveBeenCalled();
  });

  it("db append failure via a broken pool warns and never throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const badPool = {
      connect: async () => {
        throw new Error("db down");
      },
    } as unknown as Pool;

    const sink = createSorEmitSink({
      runDir: tmp,
      role: "coder",
      provider: "ollama",
      model: "m",
      sessionId: "s1",
      eventsDir: join(tmp, "events"),
      pool: badPool,
    });

    expect(() => sink.toolResult("call_1", "bash", {}, "out", false, 5)).not.toThrow();
    await new Promise((r) => setTimeout(r, 30));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[sor] db append skipped"));
  });

  it("loop survives a sink whose methods throw synchronously", async () => {
    const create = vi.fn()
      .mockImplementationOnce(async () =>
        resp({ role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }] }),
      )
      .mockImplementationOnce(async () => resp({ role: "assistant", content: "done" }));
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    const explosive: SorEmitSink = {
      toolCall: () => {
        throw new Error("sink exploded");
      },
      toolResult: () => {
        throw new Error("sink exploded");
      },
    };

    const outcome = await runAgent({
      client,
      model: "m",
      systemPrompt: "",
      task: "",
      registry: buildRegistry(defWith(["read"])),
      wtCtx: { worktreeDir: tmp, role: "coder", runDir: tmp },
      emit: () => {},
      sor: explosive,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.text).toBe("done");
  });
});

describe("loop integration: sink called once per tool_call + once per tool_result", () => {
  it("forwards call id, tool name, input, full output, ok flag and duration", async () => {
    const wt = mkdtempSync(join(tmpdir(), "sor-loop-"));
    writeFileSync(join(wt, "hello.txt"), "hello sor\n");
    try {
      const create = vi.fn()
        .mockImplementationOnce(async () =>
          resp({ role: "assistant", content: null, tool_calls: [{ id: "call_9", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "hello.txt" }) } }] }),
        )
        .mockImplementationOnce(async () => resp({ role: "assistant", content: "finished" }));
      const client = { chat: { completions: { create } } } as unknown as OpenAI;

      const calls: Array<{ method: string; args: unknown[] }> = [];
      const sink: SorEmitSink = {
        toolCall: (...args) => calls.push({ method: "toolCall", args }),
        toolResult: (...args) => calls.push({ method: "toolResult", args }),
      };

      await runAgent({
        client,
        model: "m",
        systemPrompt: "",
        task: "",
        registry: buildRegistry(defWith(["read"])),
        wtCtx: { worktreeDir: wt, role: "coder", runDir: wt },
        emit: (_e: WireEvent) => {},
        sor: sink,
      });

      expect(calls.map((c) => c.method)).toEqual(["toolCall", "toolResult"]);
      expect(calls[0]?.args).toEqual(["call_9", "read", { path: "hello.txt" }]);
      const resultArgs = calls[1]?.args as [string, string, unknown, string, boolean, number];
      expect(resultArgs[0]).toBe("call_9");
      expect(resultArgs[1]).toBe("read");
      expect(resultArgs[3]).toContain("hello sor");
      expect(resultArgs[4]).toBe(true);
      expect(typeof resultArgs[5]).toBe("number");
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  it("emitter writes two hook-shaped jsonl lines (before + after) into events.jsonl", async () => {
    const eventsDir = join(tmp, "events");
    const sink = createSorEmitSink({
      runDir: tmp,
      role: "tester",
      provider: "openrouter",
      model: "m",
      sessionId: "ses_test",
      eventsDir,
      pool: null,
    });

    sink.toolCall("call_a", "glob", { pattern: "*.ts" });
    sink.toolResult("call_a", "glob", { pattern: "*.ts" }, "/x/a.ts\n/x/b.ts", true, 12);
    await new Promise((r) => setTimeout(r, 30));

    const lines = readFileSync(join(eventsDir, "events.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.trim());
    expect(lines).toHaveLength(2);

    const before = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    const after = JSON.parse(lines[1] ?? "{}") as Record<string, unknown>;
    expect(before).toEqual(sortKeys(before));
    expect(after).toEqual(sortKeys(after));
    expect(Object.keys(before)).toEqual([
      "actor",
      "backend",
      "created_at",
      "event_type",
      "payload",
      "run_id",
    ]);
    expect(before.backend).toBe("openrouter");
    expect(before.run_id).toBeDefined();
    expect((before.payload as Record<string, unknown>).phase).toBe("before");
    expect((after.payload as Record<string, unknown>).phase).toBe("after");
    expect((after.payload as Record<string, unknown>).tool_output).toBe("/x/a.ts\n/x/b.ts");
    expect(normalizeHookLine(lines[0] ?? "")).not.toBeNull();
    expect(normalizeHookLine(lines[1] ?? "")).not.toBeNull();
  });
});

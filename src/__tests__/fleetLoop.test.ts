import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type OpenAI from "openai";
import { runAgent, type RunAgentOutcome, type WireEvent } from "../fleet/loop.ts";
import { buildRegistry, type ToolImpl, type WtCtx } from "../fleet/tools/registry.ts";
import type { FleetAgentDef, ToolName } from "../fleet/types.ts";

type MockResponse = Record<string, unknown>;

function defWith(tools: string[]): FleetAgentDef {
  return {
    name: "coder",
    systemPrompt: "",
    tools: tools as unknown as ToolName[],
    mcpAllow: [],
    skillsDir: "skills/coder",
  };
}

function resp(
  message: MockResponse,
  usage?: MockResponse | null,
): MockResponse {
  return {
    id: "chatcmpl-x",
    object: "chat.completion",
    choices: [{ index: 0, message, finish_reason: "stop" }],
    ...(usage === null ? {} : { usage: usage ?? {} }),
  };
}

function toolCallReq(name: string, args: unknown, id = "call_1"): MockResponse {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

function mockClient(script: MockResponse[]) {
  const create = vi.fn();
  for (const r of script) create.mockImplementationOnce(async () => r);
  const client = { chat: { completions: { create } } } as unknown as OpenAI;
  return { client, create };
}

let wt = "";
beforeEach(() => {
  wt = mkdtempSync(join(tmpdir(), "fleet-loop-"));
  writeFileSync(join(wt, "hello.txt"), "hello loop\n");
});

afterEach(() => {
  rmSync(wt, { recursive: true, force: true });
});

function ctx(overrides?: Partial<WtCtx>): WtCtx {
  return { worktreeDir: wt, role: "coder", ...overrides };
}

function collect() {
  const events: WireEvent[] = [];
  return { events, emit: (e: WireEvent) => events.push(e) };
}

describe("runAgent", () => {
  it("happy path: tool-call roundtrip emits ordered wire events and returns final text", async () => {
    const registry = buildRegistry(defWith(["read"]));
    const { client, create } = mockClient([
      resp({ role: "assistant", content: null, tool_calls: [toolCallReq("read", { path: "hello.txt" })] }, {
        prompt_tokens: 10,
        completion_tokens: 4,
        total_tokens: 14,
      }),
      resp({ role: "assistant", content: "file says hello" }),
    ]);
    const { events, emit } = collect();

    const outcome = await runAgent({
      client,
      model: "test-model",
      systemPrompt: "sys",
      task: "do the thing",
      registry,
      wtCtx: ctx(),
      emit,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.text).toBe("file says hello");
    expect(create).toHaveBeenCalledTimes(2);
    expect(events.map((e) => e.t)).toEqual([
      "tool_call",
      "tool_result",
      "text",
      "result",
      "step_finish",
    ]);
    const callEvt = events[0] as Extract<WireEvent, { t: "tool_call" }>;
    expect(callEvt.name).toBe("read");
    expect(callEvt.input).toEqual({ path: "hello.txt" });
    const resultEvt = events[1] as Extract<WireEvent, { t: "tool_result" }>;
    expect(resultEvt.name).toBe("read");
    expect(resultEvt.ok).toBe(true);
    expect(typeof resultEvt.ms).toBe("number");
    expect(resultEvt.ms).toBeGreaterThanOrEqual(0);
    expect(resultEvt.bytesOut).toBeGreaterThan(0);
    expect(events[3]).toEqual({ t: "result", text: "file says hello" });
    const finish = events[4] as Extract<WireEvent, { t: "step_finish" }>;
    expect(finish.usage).toEqual({
      input: 10,
      output: 4,
      reasoning: 0,
      cached: 0,
      cacheWrite: 0,
      total: 14,
    });

    const secondCall = (create.mock.calls[1] ?? [])[0] as {
      messages: Array<{ role: string; content?: unknown; tool_call_id?: string }>;
    };
    const roles = secondCall.messages.map((m) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "tool"]);
    const toolMsg = secondCall.messages[3] as {
      role: string;
      content?: unknown;
      tool_call_id?: string;
    };
    expect(toolMsg.tool_call_id).toBe("call_1");
    expect(toolMsg.content).toContain("hello loop");
  });

  it("usage tolerance: full usage extracts all fields including reasoning and cacheWrite", async () => {
    const { client } = mockClient([
      resp({ role: "assistant", content: "done" }, {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        prompt_tokens_details: { cached_tokens: 20, cache_write: 5 },
        completion_tokens_details: { reasoning_tokens: 8 },
        cost: 0.01,
      }),
    ]);
    const { events, emit } = collect();

    const outcome = await runAgent({
      client,
      model: "m",
      systemPrompt: "",
      task: "",
      registry: {},
      wtCtx: ctx(),
      emit,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.usage).toEqual({
      input: 100,
      output: 50,
      reasoning: 8,
      cached: 20,
      cacheWrite: 5,
      total: 150,
    });
    expect(outcome.costUsd).toBe(0.01);
  });

  it("usage tolerance: missing reasoning/cacheWrite details count as zero without crashing", async () => {
    const { client } = mockClient([
      resp({ role: "assistant", content: "done" }, {
        prompt_tokens: 12,
        completion_tokens: 3,
        total_tokens: 15,
        prompt_tokens_details: { cached_tokens: 2 },
      }),
    ]);
    const { events, emit } = collect();

    const outcome = await runAgent({
      client,
      model: "m",
      systemPrompt: "",
      task: "",
      registry: {},
      wtCtx: ctx(),
      emit,
    });

    expect(outcome.usage.reasoning).toBe(0);
    expect(outcome.usage.cacheWrite).toBe(0);
    expect(outcome.usage.cached).toBe(2);
    expect(outcome.usage.total).toBe(15);
    const finish = events.find((e): e is Extract<WireEvent, { t: "step_finish" }> => e.t === "step_finish");
    expect(finish).toBeDefined();
    expect(finish?.usage.reasoning).toBe(0);
  });

  it("usage tolerance: no usage at all accumulates to all zeros but still emits step_finish", async () => {
    const { client } = mockClient([resp({ role: "assistant", content: "ok" })]);
    const { events, emit } = collect();

    const outcome = await runAgent({
      client,
      model: "m",
      systemPrompt: "",
      task: "",
      registry: {},
      wtCtx: ctx(),
      emit,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.usage).toEqual({
      input: 0,
      output: 0,
      reasoning: 0,
      cached: 0,
      cacheWrite: 0,
      total: 0,
    });
    expect(outcome.costUsd).toBe(0);
    expect(events.at(-1)?.t).toBe("step_finish");
  });

  it("costUsd comes from provider metadata when present and stays 0 when absent", async () => {
    const withCost = mockClient([
      resp({ role: "assistant", content: "a" }, { prompt_tokens: 1, completion_tokens: 1, cost: 0.25 }),
    ]);
    const o1 = await runAgent({
      client: withCost.client,
      model: "m",
      systemPrompt: "",
      task: "",
      registry: {},
      wtCtx: ctx(),
      emit: collect().emit,
    });
    expect(o1.costUsd).toBe(0.25);

    const noCost = mockClient([
      resp({ role: "assistant", content: "a" }, { prompt_tokens: 1, completion_tokens: 1 }),
    ]);
    const o2 = await runAgent({
      client: noCost.client,
      model: "m",
      systemPrompt: "",
      task: "",
      registry: {},
      wtCtx: ctx(),
      emit: collect().emit,
    });
    expect(o2.costUsd).toBe(0);

    const ollama = mockClient([
      resp({ role: "assistant", content: "a" }, { prompt_tokens: 1, completion_tokens: 1, cost: 9 }),
    ]);
    const o3 = await runAgent({
      client: ollama.client,
      model: "m",
      systemPrompt: "",
      task: "",
      registry: {},
      wtCtx: ctx(),
      emit: collect().emit,
      provider: "ollama",
    });
    expect(o3.costUsd).toBe(0);
  });

  it("multi-step accumulation sums usage across at least two steps", async () => {
    const registry = buildRegistry(defWith(["read"]));
    const { client } = mockClient([
      resp({ role: "assistant", content: null, tool_calls: [toolCallReq("read", { path: "hello.txt" })] }, {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        completion_tokens_details: { reasoning_tokens: 2 },
        cost: 0.001,
      }),
      resp({ role: "assistant", content: null, tool_calls: [toolCallReq("read", { path: "hello.txt" }, "call_2")] }, {
        prompt_tokens: 30,
        completion_tokens: 7,
        total_tokens: 37,
        completion_tokens_details: { reasoning_tokens: 3 },
        cost: 0.002,
      }),
      resp({ role: "assistant", content: "finished" }, {
        prompt_tokens: 60,
        completion_tokens: 8,
        total_tokens: 68,
        completion_tokens_details: { reasoning_tokens: 5 },
        cost: 0.004,
      }),
    ]);
    const { events, emit } = collect();

    const outcome = await runAgent({
      client,
      model: "m",
      systemPrompt: "",
      task: "",
      registry,
      wtCtx: ctx(),
      emit,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.usage).toEqual({
      input: 100,
      output: 20,
      reasoning: 10,
      cached: 0,
      cacheWrite: 0,
      total: 120,
    });
    expect(outcome.costUsd).toBeCloseTo(0.007, 10);
    expect(events.filter((e) => e.t === "step_finish")).toHaveLength(1);
    expect(events.at(-1)?.t).toBe("step_finish");
  });

  it("error path: SDK throw mid-loop emits error event, failed outcome, no result event", async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error("boom from sdk"));
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    const { events, emit } = collect();

    const outcome = await runAgent({
      client,
      model: "m",
      systemPrompt: "",
      task: "",
      registry: buildRegistry(defWith(["read"])),
      wtCtx: ctx(),
      emit,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe("boom from sdk");
    expect(events.map((e) => e.t)).toEqual(["error"]);
    expect(events.some((e) => e.t === "result")).toBe(false);
    expect(events.some((e) => e.t === "step_finish")).toBe(false);
  });

  it("unknown tool hallucinated by the model yields ok:false tool_result and the loop continues", async () => {
    const registry = buildRegistry(defWith(["read"]));
    const exec = registry.read?.exec;
    const readExec = vi.spyOn(registry.read as ToolImpl, "exec").mockImplementation(exec!);
    const { client, create } = mockClient([
      resp({ role: "assistant", content: null, tool_calls: [toolCallReq("web_search", { q: "x" })] }),
      resp({ role: "assistant", content: "recovered" }),
    ]);
    const { events, emit } = collect();

    const outcome = await runAgent({
      client,
      model: "m",
      systemPrompt: "",
      task: "",
      registry,
      wtCtx: ctx(),
      emit,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.text).toBe("recovered");
    expect(create).toHaveBeenCalledTimes(2);
    expect(readExec).not.toHaveBeenCalled();
    const resultEvt = events[1] as Extract<WireEvent, { t: "tool_result" }>;
    expect(resultEvt?.name).toBe("web_search");
    expect(resultEvt?.ok).toBe(false);
    expect(typeof resultEvt?.ms).toBe("number");
    expect(typeof resultEvt?.bytesOut).toBe("number");
    const secondMessages = ((create.mock.calls[1] ?? [])[0] as {
      messages: Array<{ role: string; content?: unknown }>;
    }).messages;
    expect(secondMessages.at(-1)).toMatchObject({
      role: "tool",
      content: expect.stringContaining("unknown tool"),
    });
    expect(events.at(-1)?.t).toBe("step_finish");
  });

  it("abort after first tool result stops scheduling further LLM calls and emits terminal error", async () => {
    const controller = new AbortController();
    const registry = buildRegistry(defWith(["read"]));
    const innerExec = registry.read!.exec.bind(registry.read!);
    (registry as Record<string, ToolImpl>).read = {
      schema: registry.read!.schema,
      exec: async (input, c) => {
        const out = await innerExec(input, c);
        controller.abort();
        return out;
      },
    };
    const { client, create } = mockClient([
      resp({ role: "assistant", content: null, tool_calls: [toolCallReq("read", { path: "hello.txt" })] }),
      resp({ role: "assistant", content: "should never run" }),
    ]);
    const { events, emit } = collect();

    const outcome = await runAgent({
      client,
      model: "m",
      systemPrompt: "",
      task: "",
      registry,
      wtCtx: ctx(),
      emit,
      signal: controller.signal,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/aborted/);
    expect(create).toHaveBeenCalledTimes(1);
    const types = events.map((e) => e.t);
    expect(types.indexOf("tool_result")).toBeGreaterThan(-1);
    expect(types).not.toContain("text");
    expect(types).not.toContain("result");
    expect(types.at(-1)).toBe("error");
  });

  it("abort before a step skips the LLM call entirely", async () => {
    const controller = new AbortController();
    controller.abort();
    const { client, create } = mockClient([]);
    const { events, emit } = collect();

    const outcome = await runAgent({
      client,
      model: "m",
      systemPrompt: "",
      task: "",
      registry: buildRegistry(defWith(["read"])),
      wtCtx: ctx(),
      emit,
      signal: controller.signal,
    });

    expect(outcome.ok).toBe(false);
    expect(create).not.toHaveBeenCalled();
    expect(events.map((e) => e.t)).toEqual(["error"]);
  });

  it("maxSteps exhaustion takes the error path instead of looping forever", async () => {
    const endless = (): MockResponse =>
      resp({ role: "assistant", content: null, tool_calls: [toolCallReq("read", { path: "hello.txt" }, `call_${Math.random()}`)] });
    const { client, create } = mockClient(Array.from({ length: 3 }, endless));
    const { events, emit } = collect();

    const outcome: RunAgentOutcome = await runAgent({
      client,
      model: "m",
      systemPrompt: "",
      task: "",
      registry: buildRegistry(defWith(["read"])),
      wtCtx: ctx(),
      emit,
      maxSteps: 3,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("max steps (3)");
    expect(create).toHaveBeenCalledTimes(3);
    expect(events.filter((e) => e.t === "tool_call")).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({ t: "error", error: expect.stringContaining("max steps") });
    expect(events.some((e) => e.t === "result")).toBe(false);
  });

  it("malformed JSON tool arguments degrade to empty input via tool error, not a crash", async () => {
    const registry = buildRegistry(defWith(["read"]));
    const { client } = mockClient([
      resp({
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_bad", type: "function", function: { name: "read", arguments: "{not json" } },
        ],
      }),
      resp({ role: "assistant", content: "moved on" }),
    ]);
    const { events, emit } = collect();

    const outcome = await runAgent({
      client,
      model: "m",
      systemPrompt: "",
      task: "",
      registry,
      wtCtx: ctx(),
      emit,
    });

    expect(outcome.ok).toBe(true);
    const resultEvt = events[1] as Extract<WireEvent, { t: "tool_result" }>;
    expect(resultEvt.ok).toBe(false);
    expect(outcome.text).toBe("moved on");
  });

  it("echoes provider thought signatures back on assistant tool_call turns", async () => {
    const registry = buildRegistry(defWith(["read"]));
    const signature = { google: { thought_signature: "sig-abc-123" } };
    const first = resp({
      role: "assistant",
      content: null,
      tool_calls: [
        { ...toolCallReq("read", { path: "hello.txt" }), extra_content: signature },
      ],
    });
    const second = resp({ role: "assistant", content: "done" });
    const { client, create } = mockClient([first, second]);
    const { emit } = collect();

    await runAgent({
      client,
      model: "m",
      systemPrompt: "",
      task: "",
      registry,
      wtCtx: ctx(),
      emit,
    });

    expect(create).toHaveBeenCalledTimes(2);
    const secondCall = create.mock.calls[1]?.[0] as {
      messages: Array<{ role: string; tool_calls?: Array<Record<string, unknown>> }>;
    };
    const echoed = secondCall.messages.find((m) => m.role === "assistant");
    expect(echoed?.tool_calls?.[0]?.extra_content).toEqual(signature);
  });

  it("retries transient provider errors with backoff and recovers", async () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const registry = buildRegistry(defWith([]));
      const transient = Object.assign(new Error("429 RESOURCE_EXHAUSTED"), { status: 429 });
      const { client, create } = mockClient([]);
      create.mockImplementationOnce(async () => {
        throw transient;
      });
      create.mockImplementationOnce(async () => resp({ role: "assistant", content: "recovered" }));
      const { events, emit } = collect();

      const pending = runAgent({
        client,
        model: "m",
        systemPrompt: "",
        task: "",
        registry,
        wtCtx: ctx(),
        emit,
      });
      await vi.advanceTimersByTimeAsync(15000);
      const outcome = await pending;

      expect(outcome.ok).toBe(true);
      expect(outcome.text).toBe("recovered");
      expect(create).toHaveBeenCalledTimes(2);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("[llm-retry]"));
      expect(events.some((e) => e.t === "error")).toBe(false);
    } finally {
      errSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("parseRetryDelayMs honors the server-suggested retry window", async () => {
    const { parseRetryDelayMs } = await import("../fleet/loop.ts");
    const serverSaid = new Error(
      '429 quota ... "retryDelay":"19s" ... Please retry in 19.923033201s.',
    );
    expect(parseRetryDelayMs(serverSaid)).toBeGreaterThan(19000);
    expect(parseRetryDelayMs(serverSaid)).toBeLessThan(20000);
    expect(parseRetryDelayMs(new Error('"retryDelay":"30s"'))).toBe(30000);
    expect(parseRetryDelayMs(new Error("no hint here"))).toBeNull();
  });

  it("does not retry non-transient provider errors", async () => {
    const registry = buildRegistry(defWith([]));
    const badRequest = Object.assign(new Error("400 INVALID_ARGUMENT"), { status: 400 });
    const { client, create } = mockClient([]);
    create.mockImplementationOnce(async () => {
      throw badRequest;
    });
    const { events, emit } = collect();

    const outcome = await runAgent({
      client,
      model: "m",
      systemPrompt: "",
      task: "",
      registry,
      wtCtx: ctx(),
      emit,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("400");
    expect(create).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.t === "error")).toBe(true);
  });
});

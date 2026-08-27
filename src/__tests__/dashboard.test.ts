import { readFileSync } from "node:fs";
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { newDashboardState, renderDashboard } from "../tui/dashboard.ts";
import { WebDashboard, type WebhookResponse } from "../dashboard/webDashboard.ts";
import { availableModels } from "../models/modelPolicy.ts";
import { listModelsForProvider } from "../providers/registry.ts";
import type { QuotaEvent } from "../fleet/quotaEvents.ts";
import type { ProviderName, Role } from "../types.ts";

vi.mock("../providers/registry.ts", () => ({
  listModelsForProvider: vi.fn(async () => [] as string[]),
}));

const listModelsMock = vi.mocked(listModelsForProvider);

const ROLES: Role[] = ["analyzer", "planner", "coder", "tester", "reviewer", "pr"];

function getDashboardSrc(): string {
  const template = readFileSync(
    new URL("../dashboard/template.html", import.meta.url),
    "utf8",
  );
  const clientJs = readFileSync(
    new URL("../dashboard/client.js", import.meta.url),
    "utf8",
  );
  return template + "\n" + clientJs;
}

describe("dashboard", () => {
  describe("newDashboardState", () => {
    it("initializes phase to idle", () => {
      const d = newDashboardState("run-1", "owner/repo", 7);
      expect(d.phase).toBe("idle");
    });

    it("stores the run metadata", () => {
      const d = newDashboardState("run-abc", "owner/repo", 7);
      expect(d.runId).toBe("run-abc");
      expect(d.repo).toBe("owner/repo");
      expect(d.issue).toBe(7);
    });

    it("initializes loopIteration to 1", () => {
      const d = newDashboardState("run-1", "owner/repo", 7);
      expect(d.loopIteration).toBe(1);
    });

    it("creates a pending placeholder agent status for every role", () => {
      const d = newDashboardState("run-1", "owner/repo", 7);
      for (const role of ROLES) {
        expect(d.agents[role]).toMatchObject({
          role,
          state: "pending",
          model: "",
        });
      }
    });

  describe("embedded page provider wiring (P8)", () => {
    const src = getDashboardSrc();

    it("purges all dead backend-era identifiers", () => {
      expect(src).not.toContain("backend-btn");
      expect(src).not.toContain("data-backend");
      expect(src).not.toContain("postBackend");
      expect(src).not.toContain("renderBackend");
    });

    it("wires the onLoad block to .provider-btn / postProvider / renderProvider", () => {
      const onLoad = src.match(/function onLoad\(\) \{[\s\S]*?\n  \}/);
      expect(onLoad).not.toBeNull();
      expect(onLoad![0]).toContain('querySelectorAll(".provider-btn")');
      expect(onLoad![0]).toContain('this.getAttribute("data-provider")');
      expect(onLoad![0]).toContain("postProvider(");
      expect(onLoad![0]).toContain("renderProvider();");
    });

    it("renders provider buttons with data-provider attributes in the HTML", () => {
      for (const p of ["gemini", "openrouter", "ollama"]) {
        expect(src).toContain(`class="provider-btn" data-provider="${p}"`);
      }
    });
  });

  describe("GET /api/models (live list + static fallback)", () => {
    let dashboard: WebDashboard;
    let baseUrl: string;

    beforeEach(() => {
      listModelsMock.mockClear();
      listModelsMock.mockImplementation(async () => [] as string[]);
    });

    afterEach(async () => {
      await dashboard?.close();
    });

    async function setup(provider: ProviderName = "gemini") {
      dashboard = new WebDashboard(0, "/tmp", undefined, provider, null);
      const info = await dashboard.start();
      expect(info).not.toBeNull();
      baseUrl = info!.url;
    }

    it("serves the deduped live model list from registry.listModelsForProvider", async () => {
      await setup();
      listModelsMock.mockImplementation(
        async () => ["zeta/one", "alpha/two", "zeta/one"],
      );
      const telemetry = vi.spyOn(dashboard, "pushTelemetry");
      const res = await fetch(`${baseUrl}api/models?provider=openrouter`);
      expect(res.status).toBe(200);
      const json = await res.json() as {
        models: Record<string, string>;
        available: string[];
        trafficClass: string;
        generationReservation: boolean;
      };
      expect(json.available).toEqual(["zeta/one", "alpha/two"]);
      expect(json.models).toEqual({});
      expect(json.trafficClass).toBe("metadata");
      expect(json.generationReservation).toBe(false);
      expect(listModelsMock).toHaveBeenCalledWith("openrouter");
      expect(telemetry).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          event: "metadata_model_discovery",
          trafficClass: "metadata",
          generationReservation: false,
          provider: "openrouter",
          status: "started",
        }),
      );
      expect(telemetry).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ trafficClass: "metadata", generationReservation: false, status: "completed" }),
      );
    });

    it("falls back to static tier defaults when the live list is empty (offline/error)", async () => {
      await setup();
      const res = await fetch(`${baseUrl}api/models?provider=gemini`);
      expect(res.status).toBe(200);
      const json = await res.json() as { available: string[] };
      expect(json.available).toEqual([...availableModels("gemini")]);
      expect(json.available.length).toBeGreaterThan(0);
    });

    it("falls back to the active provider's tier defaults for an unknown provider param", async () => {
      await setup("openrouter");
      const res = await fetch(`${baseUrl}api/models?provider=nonsense`);
      expect(res.status).toBe(200);
      const json = await res.json() as { available: string[] };
      expect(json.available).toEqual([...availableModels("openrouter")]);
      expect(listModelsMock).toHaveBeenCalledWith("openrouter");
    });

    it("includes envModels from per-role env vars in the response", async () => {
      process.env.PLANNER_MODEL_GEMINI = "test-model-xyz";
      try {
        await setup();
        const res = await fetch(`${baseUrl}api/models?provider=gemini`);
        expect(res.status).toBe(200);
        const json = await res.json() as { envModels: Record<string, string> };
        expect(json.envModels).toBeDefined();
        expect(json.envModels.planner).toBe("test-model-xyz");
      } finally {
        delete process.env.PLANNER_MODEL_GEMINI;
      }
    });
  });

    it("defaults backend to gemini (primary provider path)", () => {
      const d = newDashboardState("run-1", "owner/repo", 7);
      expect(d.backend).toBe("gemini");
    });

    it("records a supplied backend", () => {
      const d = newDashboardState("run-1", "owner/repo", 7, "ollama");
      expect(d.backend).toBe("ollama");
    });
  });

  describe("renderDashboard", () => {
    it("includes the run id, repo and issue in the header", () => {
      const d = newDashboardState("run-42", "owner/repo", 7);
      const out = renderDashboard(d);
      expect(out).toContain("run-42");
      expect(out).toContain("owner/repo#7");
    });

    it("shows the backend in the header", () => {
      const d = newDashboardState("run-42", "owner/repo", 7, "openrouter");
      const out = renderDashboard(d);
      expect(out).toContain("openrouter");
    });

    it("lists every role", () => {
      const d = newDashboardState("run-1", "owner/repo", 7);
      const out = renderDashboard(d);
      for (const role of ROLES) {
        expect(out).toContain(role);
      }
    });

    it("renders a '·' bullet for pending agents", () => {
      const d = newDashboardState("run-1", "owner/repo", 7);
      const out = renderDashboard(d);
      expect(out).toContain("·");
    });

    it("renders a '✓' and cost for a done agent with cost info", () => {
      const d = newDashboardState("run-1", "owner/repo", 7);
      d.phase = "done";
      d.agents.coder = {
        role: "coder",
        state: "done",
        model: "opencode/laguna-s-2.1-free",
        costUsd: 0.123,
        tokens: { input: 10, output: 5, reasoning: 0, cached: 0, cacheWrite: 0, total: 15 },
      };
      const out = renderDashboard(d);
      expect(out).toContain("✓");
      expect(out).toContain("$0.123");
      expect(out).toContain("in 10 / out 5 / cached 0");
    });

    it("renders a '✗' and error for a failed agent", () => {
      const d = newDashboardState("run-1", "owner/repo", 7);
      d.phase = "failed";
      d.agents.analyzer = {
        role: "analyzer",
        state: "failed",
        model: "opencode/deepseek-v4-flash-free",
        error: "timeout",
      };
      const out = renderDashboard(d);
      expect(out).toContain("✗");
      expect(out).toContain("timeout");
    });

    it("renders a partial progress bar for a running agent", () => {
      const d = newDashboardState("run-1", "owner/repo", 7);
      d.phase = "failed";
      d.agents.coder = {
        role: "coder",
        state: "running",
        model: "opencode/laguna-s-2.1-free",
      };
      const out = renderDashboard(d);
      const barChars = (out.match(/█/g) || []).length;
      expect(barChars).toBeGreaterThan(0);
      expect(barChars).toBeLessThan(20);
    });

    it("renders an empty progress bar for a failed agent", () => {
      const d = newDashboardState("run-1", "owner/repo", 7);
      d.phase = "failed";
      d.agents.reviewer = {
        role: "reviewer",
        state: "failed",
        model: "opencode/deepseek-v4-flash-free",
        error: "timeout",
      };
      const out = renderDashboard(d);
      expect(out).not.toContain("█");
    });
  });

  describe("renderDashboard quota notice", () => {
    it("renders the latest quota event as a single status line", () => {
      const d = newDashboardState("run-1", "owner/repo", 7);
      d.quotaNotice = "coder: gemini-3.5-flash rate limited (rpm) → gemma-4-31b-it";
      const out = renderDashboard(d);
      expect(out).toContain("⚠ coder: gemini-3.5-flash rate limited (rpm) → gemma-4-31b-it");
    });

    it("overwrites the line with newer events (single notice field)", () => {
      const d = newDashboardState("run-1", "owner/repo", 7);
      d.quotaNotice = "coder: a rate limited (rpm) → b";
      d.quotaNotice = "analyzer: b available again → switching back";
      const out = renderDashboard(d);
      expect(out).toContain("analyzer: b available again → switching back");
      expect(out).not.toContain("coder: a rate limited");
    });

    it("omits the status line when no quota notice is set", () => {
      const out = renderDashboard(newDashboardState("run-1", "owner/repo", 7));
      expect(out).not.toContain("⚠");
    });

    it("renders exhaustion notices prominently until overwritten or the next run", () => {
      const d = newDashboardState("run-1", "owner/repo", 7);
      d.quotaNotice = "all Gemini models RPD exhausted for coder — change your API key";
      const out = renderDashboard(d);
      expect(out).toContain("⚠⚠ all Gemini models RPD exhausted for coder — change your API key");
    });

    it("a fresh dashboard state clears the previous run's notice", () => {
      const prev = newDashboardState("run-1", "owner/repo", 7);
      prev.quotaNotice = "all Gemini models RPD exhausted for coder — change your API key";
      expect(prev.quotaNotice).toBeDefined();
      const next = newDashboardState("run-2", "owner/repo", 8);
      expect(next.quotaNotice).toBeUndefined();
      expect(renderDashboard(next)).not.toContain("exhausted");
    });
  });

  describe("POST /webhook", () => {
    let dashboard: WebDashboard;
    let baseUrl: string;

    afterEach(async () => {
      await dashboard?.close();
    });

    async function setupDashboard(
      onWebhook?: (headers: Record<string, string | string[] | undefined>, rawBody: string) => Promise<WebhookResponse>,
    ) {
      dashboard = new WebDashboard(0, "/tmp", undefined, "gemini", null, onWebhook);
      const info = await dashboard.start();
      expect(info).not.toBeNull();
      baseUrl = info!.url;
    }

    it("bypasses guardMutation and invokes the callback with headers + raw body intact", async () => {
      let receivedHeaders: Record<string, string | string[] | undefined> | null = null;
      let receivedBody: string | null = null;

      await setupDashboard(async (headers, rawBody) => {
        receivedHeaders = headers;
        receivedBody = rawBody;
        return { status: 200, body: { ok: true } };
      });

      const payload = JSON.stringify({ action: "opened", issue: { number: 42 } });
      const res = await fetch(`${baseUrl}webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": "issues",
          "X-Hub-Signature-256": "sha256=abc123",
        },
        body: payload,
      });
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json).toEqual({ ok: true });
      expect(receivedBody).toBe(payload);
      expect(receivedHeaders).not.toBeNull();
      expect(receivedHeaders!["x-github-event"]).toBe("issues");
      expect(receivedHeaders!["x-hub-signature-256"]).toBe("sha256=abc123");
    });

    it("forwards a bad-signature 401 response verbatim from the callback", async () => {
      await setupDashboard(async () => {
        return { status: 401, body: { error: "invalid signature" } };
      });

      const res = await fetch(`${baseUrl}webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const json = await res.json();

      expect(res.status).toBe(401);
      expect(json).toEqual({ error: "invalid signature" });
    });

    it("returns 503 when no onWebhook is configured", async () => {
      await setupDashboard(undefined);

      const res = await fetch(`${baseUrl}webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const json = await res.json();

      expect(res.status).toBe(503);
      expect(json).toEqual({ error: "webhook not configured" });
    });

    it("returns the status and body from a valid delivery callback", async () => {
      await setupDashboard(async () => {
        return { status: 200, body: { queued: true } };
      });

      const res = await fetch(`${baseUrl}webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "opened" }),
      });
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json).toEqual({ queued: true });
    });

    it("passes ping event through to the callback (routing is upstream)", async () => {
      let receivedHeaders: Record<string, string | string[] | undefined> | null = null;

      await setupDashboard(async (headers) => {
        receivedHeaders = headers;
        return { status: 200, body: { ignored: true } };
      });

      const res = await fetch(`${baseUrl}webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": "ping",
        },
        body: JSON.stringify({ zen: "Keep it simple." }),
      });
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json).toEqual({ ignored: true });
      expect(receivedHeaders!["x-github-event"]).toBe("ping");
    });

    it("returns 413 and destroys the connection for oversize bodies (>256KB)", async () => {
      await setupDashboard(async () => {
        return { status: 200, body: { ok: true } };
      });

      const oversizedBody = "x".repeat(256 * 1024 + 1);
      const res = await fetch(`${baseUrl}webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: oversizedBody,
      });
      const json = await res.json();

      expect(res.status).toBe(413);
      expect(json).toEqual({ error: "body too large" });
    });
  });

  describe("formatAgentEvent (embedded JS)", () => {
    const src = getDashboardSrc();
    // Extract the formatAgentEvent function body from the template string
    const match = src.match(
      /function formatAgentEvent\(ev\) \{[\s\S]*?^  \}/m,
    );
    if (!match) throw new Error("Could not extract formatAgentEvent from source");
    // formatAgentEvent calls the fmtErr client helper; extract it too so the
    // evaluated function sees the real source implementation.
    const errMatch = src.match(/function fmtErr\(v\) \{[\s\S]*?\n  \}/);
    if (!errMatch) throw new Error("Could not extract fmtErr from source");

    const esc = (s: unknown) => String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    // eslint-disable-next-line no-eval
    const fmtErr = eval("(function(){ " + errMatch[0] + " return fmtErr; })")() as (
      v: unknown,
    ) => string;
    // eslint-disable-next-line no-eval
    const fn = eval("(function(esc, fmtErr){ " + match[0] + " return formatAgentEvent; })") as (
      esc: (s: unknown) => string,
      fmtErr: (v: unknown) => string,
    ) => (ev: Record<string, unknown>) => string;
    const format = fn(esc, fmtErr);

    it("returns empty string for step_start", () => {
      const ev = {
        type: "step_start",
        part: { type: "step-start", id: "prt_abc", messageID: "msg_1", sessionID: "sess_1", snapshot: "" },
      };
      expect(format(ev)).toBe("");
    });

    it("renders tool_use with tool name, status checkmark, and command preview", () => {
      const ev = {
        type: "tool_use",
        part: {
          type: "tool",
          tool: "bash",
          callID: "call_abc",
          state: {
            status: "completed",
            input: { command: "git status", workdir: "/repo" },
            output: "On branch main",
          },
        },
      };
      const html = format(ev);
      expect(html).toContain("⚙");
      expect(html).toContain("bash");
      expect(html).toContain("✓");
      expect(html).toContain("git status");
      expect(html).not.toContain("callID");
    });

    it("renders tool_use with cross for non-completed status", () => {
      const ev = {
        type: "tool_use",
        part: {
          type: "tool",
          tool: "bash",
          callID: "call_err",
          state: {
            status: "error",
            input: { command: "rm -rf /" },
            output: "Permission denied",
          },
        },
      };
      const html = format(ev);
      expect(html).toContain("✗");
      expect(html).toContain("Permission denied");
    });

    it("renders step_finish with token summary and cost", () => {
      const ev = {
        type: "step_finish",
        part: {
          reason: "stop",
          tokens: { input: 4359, output: 215, reasoning: 0, total: 4574, cache: {} },
          cost: 0.0001,
        },
      };
      const html = format(ev);
      expect(html).toContain("in 4359");
      expect(html).toContain("out 215");
      expect(html).toContain("$0.000100");
    });

    it("renders text events with content", () => {
      const ev = { type: "text", part: { type: "text", text: "Hello world" } };
      const html = format(ev);
      expect(html).toContain("Hello world");
    });

    it("falls back to compact code tag for unknown event types", () => {
      const ev = { type: "weird_thing", part: { foo: 123 } };
      const html = format(ev);
      expect(html).toContain("weird_thing");
      expect(html).toContain("<code>");
    });

    it("renders object error payloads as JSON, never [object Object]", () => {
      const html = format({ t: "error", error: { message: "boom" } });
      expect(html).toContain('{"message":"boom"}');
      expect(html).not.toContain("[object Object]");
    });

    it("renders string error payloads verbatim via fmtErr", () => {
      const html = format({ t: "error", error: "plain failure" });
      expect(html).toContain("plain failure");
    });
  });

  describe("embedded error formatting hardening (fmtErr)", () => {
    const src = getDashboardSrc();

    it("defines the fmtErr client helper next to esc", () => {
      expect(src).toMatch(/function fmtErr\(v\) \{/);
      expect(src).toContain("if (typeof v === \"string\") return v;");
      expect(src).toContain("JSON.stringify(v)");
    });

    it("routes card() errors through fmtErr instead of raw esc()", () => {
      expect(src).toContain("esc(fmtErr(a.error))");
      expect(src).not.toContain("esc(a.error)");
    });

    it("replaces String(errMsg) with fmtErr(errMsg) in formatAgentEvent's error branch", () => {
      expect(src).toContain("esc(fmtErr(errMsg).slice(0, 500))");
      expect(src).not.toContain("String(errMsg)");
    });
  });

  describe("outputs / agentEvents isolation", () => {
    it("keeps pushOutput strings out of agentEvents and vice versa", () => {
      const dash = new WebDashboard(0, "/tmp", undefined, "gemini", null);
      dash.pushOutput("planner", "final answer text");
      dash.pushAgentEvent("planner", { t: "init" });
      const internal = dash as unknown as {
        outputs: Record<Role, string[]>;
        agentEvents: Record<Role, Record<string, unknown>[]>;
      };
      expect(internal.outputs.planner).toEqual(["final answer text"]);
      expect(internal.agentEvents.planner).toEqual([{ t: "init" }]);
      expect(internal.agentEvents.planner).not.toBe(internal.outputs.planner);
      expect(internal.agentEvents.planner.some((e) => typeof e === "string")).toBe(false);
      expect(internal.outputs.planner.every((c) => typeof c === "string")).toBe(true);
    });
  });

  // Regression coverage for "transcript pane full-rebuilds on every SSE event
  // instead of incremental append": pushText/pushAgentEvent used to call the
  // full renderLog()/renderAgentEvents() rebuild (regenerating innerHTML for
  // the whole pane) on every single chunk/event. They should now append just
  // the new line/event via dedicated appendLogLine/appendAgentEvent helpers.
  describe("embedded page transcript rendering (incremental append)", () => {
    const src = getDashboardSrc();

    it("defines appendLogLine and appendAgentEvent helpers", () => {
      expect(src).toContain("function appendLogLine(L)");
      expect(src).toContain("function appendAgentEvent(role, ev)");
    });

    it("pushText appends a single line instead of calling the full renderLog rebuild", () => {
      const fn = src.match(/function pushText\(role, text\) \{[\s\S]*?\n  \}/);
      expect(fn).not.toBeNull();
      const body = fn![0];
      expect(body).toContain("appendLogLine(L)");
      expect(body).not.toContain("renderLog()");
    });

    it("pushAgentEvent appends a single event instead of calling the full renderAgentEvents rebuild", () => {
      const fn = src.match(/function pushAgentEvent\(role, ev\) \{[\s\S]*?\n  \}/);
      expect(fn).not.toBeNull();
      const body = fn![0];
      expect(body).toContain("appendAgentEvent(role, ev)");
      expect(body).not.toContain("renderAgentEvents()");
    });

    it("appendLogLine inserts via insertAdjacentHTML rather than rebuilding innerHTML", () => {
      const fn = src.match(/function appendLogLine\(L\) \{[\s\S]*?\n  \}/);
      expect(fn).not.toBeNull();
      expect(fn![0]).toContain("insertAdjacentHTML");
    });

    it("appendAgentEvent inserts via insertAdjacentHTML rather than rebuilding innerHTML", () => {
      const fn = src.match(/function appendAgentEvent\(role, ev\) \{[\s\S]*?\n  \}/);
      expect(fn).not.toBeNull();
      expect(fn![0]).toContain("insertAdjacentHTML");
    });

    it("renderLog and renderAgentEvents remain as full-rebuild seed functions", () => {
      expect(src).toContain("function renderLog() {");
      expect(src).toContain("function renderAgentEvents() {");
    });

    // Regression coverage for the "transcript pane goes stale after a
    // reconnect/snapshot arrives while the user is on another tab" bug: the
    // agentEvents seed branch in applyState used to only call
    // renderAgentEvents() when curTab === "transcript". Since the transcript
    // DOM is now maintained incrementally and nothing re-renders it on tab
    // switch, that gate left the pane permanently stale for anyone not on
    // the transcript tab at the moment a snapshot landed. The seed rebuild
    // must run unconditionally.
    it("applyState rebuilds agentEvents unconditionally, not gated on curTab", () => {
      const fn = src.match(/function applyState\(s\) \{[\s\S]*?\n  \}/);
      expect(fn).not.toBeNull();
      const block = fn![0].match(/if \(s\.agentEvents[\s\S]*?\n    \}/);
      expect(block).not.toBeNull();
      expect(block![0]).not.toMatch(/if \(curTab/);
      expect(block![0]).toMatch(/\n\s*renderAgentEvents\(\);\n/);
    });
  });

  describe("call counters (embedded JS)", () => {
    const src = getDashboardSrc();

    const extractFn = (name: string, args: string) => {
      const m = src.match(new RegExp(`function ${name}\\(${args}\\) \\{[\\s\\S]*?\\n  \\}`));
      if (!m) throw new Error(`Could not extract ${name} from source`);
      // eslint-disable-next-line no-eval
      return eval(`(function(){ ${m[0]} return ${name}; })`)() as (...a: unknown[]) => unknown;
    };

    const fmtCalls = extractFn("fmtCalls", "c") as (c: unknown) => string;
    const n = extractFn("n", "v") as (v: unknown) => string;

    it("fmtCalls returns empty string for undefined/null counters", () => {
      expect(fmtCalls(undefined)).toBe("");
      expect(fmtCalls(null)).toBe("");
    });

    it("fmtCalls returns empty string when all counts are zero", () => {
      expect(fmtCalls({ tools: 0, models: 0, skills: 0 })).toBe("");
    });

    it("fmtCalls renders partial counters only", () => {
      const out = fmtCalls({ tools: 4, models: 0, skills: 0 });
      expect(out).toContain("⚙4");
      expect(out).not.toContain("🤖");
      expect(out).not.toContain("📚");
    });

    it("fmtCalls renders all counters joined by spaces", () => {
      expect(fmtCalls({ tools: 12, models: 3, skills: 2 })).toBe("⚙12 🤖3 📚2");
    });

    it("n() formats thousands separators and defaults to zero", () => {
      expect(n(1234)).toBe("1,234");
      expect(n(undefined)).toBe("0");
      expect(n(null)).toBe("0");
    });

    it("card() emits call ticks before the done-only cost/tokens meta", () => {
      const m = src.match(/function card\(a\) \{[\s\S]*?\n  \}/);
      expect(m).not.toBeNull();
      const body = m![0];
      expect(body).toMatch(/var calls = fmtCalls\(a\.calls\);/);
      const callsIdx = body.indexOf("var calls = fmtCalls(a.calls);");
      const costIdx = body.indexOf('meta.push(fmtCost(a.costUsd))');
      expect(callsIdx).toBeGreaterThanOrEqual(0);
      expect(costIdx).toBeGreaterThan(callsIdx);
      expect(body).not.toContain("String(errMsg)");
    });

    it("renderAgents() renders the session totals strip behind a truthy guard", () => {
      const m = src.match(/function renderAgents\(\) \{[\s\S]*?\n  \}/);
      expect(m).not.toBeNull();
      const body = m![0];
      expect(body).toContain('class="totals-strip"');
      expect(body).toContain("dash.totals && (dash.totals.tools || dash.totals.models)");
    });
  });

  describe("web dashboard layout (scroll containment)", () => {
    const src = getDashboardSrc();

    it("body is a flex column that never overflows the viewport", () => {
      const m = src.match(/\nbody \{[^}]*\}/);
      expect(m).not.toBeNull();
      const body = m![0];
      expect(body).toMatch(/display:\s*flex/);
      expect(body).toMatch(/flex-direction:\s*column/);
      expect(body).toMatch(/overflow:\s*hidden/);
    });

    it("main fills remaining flex space with a constrained grid row (no calc height)", () => {
      const m = src.match(/\nmain \{[^}]*\}/);
      expect(m).not.toBeNull();
      const body = m![0];
      expect(body).toMatch(/grid-template-rows:\s*minmax\(0,\s*1fr\)/);
      expect(body).toMatch(/flex:\s*1 1 auto/);
      expect(body).toMatch(/min-height:\s*0/);
      expect(src).not.toContain("calc(100% - 96px)");
    });

    it("#lower is a fixed-height band that never displaces the footer", () => {
      const m = src.match(/#lower \{[^}]*\}/);
      expect(m).not.toBeNull();
      expect(m![0]).toMatch(/flex:\s*0 0 auto/);
      expect(m![0]).toMatch(/height:\s*clamp\(/);
    });

    it("bottom band is a body-level sibling under main; footer stays last", () => {
      const mainEnd = src.indexOf("</main>");
      const lowerIdx = src.indexOf('<div id="lower">');
      const tabsIdx = src.indexOf("switchTab('transcript'");
      const footerIdx = src.indexOf("<footer>");
      expect(mainEnd).toBeGreaterThan(0);
      expect(lowerIdx).toBeGreaterThan(mainEnd);
      expect(tabsIdx).toBeGreaterThan(lowerIdx);
      expect(footerIdx).toBeGreaterThan(tabsIdx);
    });

    it("mobile media query restores natural page scrolling", () => {
      const m = src.match(/@media \(max-width: 900px\) \{[\s\S]*?\n\}/);
      expect(m).not.toBeNull();
      const block = m![0];
      const bodyRule = block.match(/body \{[^}]*\}/);
      expect(bodyRule).not.toBeNull();
      expect(bodyRule![0]).toMatch(/overflow:\s*auto/);
      expect(block).toMatch(/#lower \{[^}]*overflow-y:\s*visible/);
    });
  });

  describe("quota events (SSE + client rendering)", () => {
    const src = getDashboardSrc();

    describe("SSE quota_event payload", () => {
      let dashboard: WebDashboard;
      let baseUrl: string;

      afterEach(async () => {
        await dashboard?.close();
      });

      async function readFramesUntil(
        predicate: (buf: string) => boolean,
        trigger: () => void,
      ): Promise<string> {
        const controller = new AbortController();
        const res = await fetch(`${baseUrl}api/events`, { signal: controller.signal });
        expect(res.status).toBe(200);
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        try {
          // give the server a beat to register this SSE client
          await new Promise((r) => setTimeout(r, 50));
          trigger();
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline) {
            const chunk = await Promise.race([
              reader.read(),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("sse read timeout")), 2000),
              ),
            ]);
            if (chunk.done) break;
            buf += decoder.decode(chunk.value, { stream: true });
            if (predicate(buf)) return buf;
          }
          throw new Error("expected SSE frame never arrived");
        } finally {
          controller.abort();
        }
      }

      const extractFrames = (buf: string, eventName: string): string[] => {
        const frames: string[] = [];
        let from = 0;
        for (;;) {
          const start = buf.indexOf(`event: ${eventName}`, from);
          if (start === -1) break;
          const end = buf.indexOf("\n\n", start);
          if (end === -1) break;
          frames.push(buf.slice(start, end + 2));
          from = end + 2;
        }
        return frames;
      };

      it("broadcasts {type:'quota_event', event:{...QuotaEvent}} for each quota event", async () => {
        dashboard = new WebDashboard(0, "/tmp", undefined, "gemini", null);
        const info = await dashboard.start();
        expect(info).not.toBeNull();
        baseUrl = info!.url;

        const switchEvent: QuotaEvent = {
          type: "model_switch",
          role: "coder",
          provider: "gemini",
          fromModel: "gemini-3.5-flash",
          toModel: "gemma-4-31b-it",
          block: "rpm",
          waitMs: 4200,
        };
        const exhaustedEvent: QuotaEvent = {
          type: "all_models_exhausted",
          role: "tester",
          provider: "gemini",
          models: ["gemini-a", "gemini-b"],
        };

        let frameBlock = "";
        await readFramesUntil(
          (buf) => {
            const frames = extractFrames(buf, "quota_event");
            if (frames.length >= 2) {
              frameBlock = frames.join("");
              return true;
            }
            return false;
          },
          () => {
            dashboard.pushQuotaEvent(switchEvent);
            dashboard.pushQuotaEvent(exhaustedEvent);
          },
        );

        const dataLines = frameBlock
          .split("\n")
          .filter((l) => l.startsWith("data: "))
          .map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);
        expect(dataLines).toEqual([
          { type: "quota_event", event: switchEvent },
          { type: "quota_event", event: exhaustedEvent },
        ]);
      });

      it("serializes recovered events through the same channel", async () => {
        dashboard = new WebDashboard(0, "/tmp", undefined, "gemini", null);
        const info = await dashboard.start();
        expect(info).not.toBeNull();
        baseUrl = info!.url;

        const recoveredEvent: QuotaEvent = {
          type: "model_recovered",
          role: "analyzer",
          provider: "gemini",
          model: "gemini-a",
        };
        let frameBlock = "";
        await readFramesUntil(
          (buf) => {
            const frames = extractFrames(buf, "quota_event");
            if (frames.length > 0) {
              frameBlock = frames[0]!;
              return true;
            }
            return false;
          },
          () => dashboard.pushQuotaEvent(recoveredEvent),
        );
        const dataLine = frameBlock.split("\n").find((l) => l.startsWith("data: "))!;
        expect(JSON.parse(dataLine.slice(6))).toEqual({ type: "quota_event", event: recoveredEvent });
      });
    });

    it("subscribes to quota_event SSE frames and routes them to handleQuotaEvent", () => {
      const sse = src.match(/function startSSE\(\) \{[\s\S]*?\n  \}/);
      expect(sse).not.toBeNull();
      expect(sse![0]).toContain('es.addEventListener("quota_event"');
      expect(sse![0]).toContain("handleQuotaEvent(d.event)");
    });

    it("toasts switch/recovered transiently and banners exhaustion persistently", () => {
      const fn = src.match(/function handleQuotaEvent\(q\) \{[\s\S]*?\n  \}/);
      expect(fn).not.toBeNull();
      const body = fn![0];
      expect(body).toContain('"model_switch"');
      expect(body).toContain('"model_recovered"');
      expect(body).toContain("showToast(");
      expect(body).toContain('"all_models_exhausted"');
      expect(body).toContain("showQuotaExhausted(");
    });

    it("toast auto-dismisses after ~6 seconds", () => {
      const fn = src.match(/function showToast\(text\) \{[\s\S]*?\n  \}/);
      expect(fn).not.toBeNull();
      expect(fn![0]).toMatch(/setTimeout\(function \(\) \{[\s\S]*?\}, 6000\)/);
    });

    it("persistent red banner carries the exact exhaustion message", () => {
      expect(src).toContain(
        'var QUOTA_EXHAUSTED_MSG = "All Gemini models RPD exhausted — change your API key. Run paused.";',
      );
      const fn = src.match(/function showQuotaExhausted\(text\) \{[\s\S]*?\n  \}/);
      expect(fn).not.toBeNull();
      expect(fn![0]).toContain('banner.hidden = false');
    });

    it("browser Notification fires only when already granted, inside try/catch (never prompts)", () => {
      const fn = src.match(/function showQuotaExhausted\(text\) \{[\s\S]*?\n  \}/);
      expect(fn).not.toBeNull();
      const body = fn![0];
      expect(body).toContain('if ("Notification" in window && Notification.permission === "granted")');
      expect(body).toMatch(/try \{[\s\S]*?Notification[\s\S]*?\} catch \(_\) \{ \}/);
      expect(body).not.toContain("requestPermission");
    });

    it("renders the banner and toast container elements in the page HTML", () => {
      expect(src).toContain('<div id="quotabanner"');
      expect(src).toContain('<span class="ghb-title" id="quotabanner-text"></span>');
      expect(src).toContain('<div id="toasts"></div>');
    });

    it("clears the persistent banner when a new queue run starts", () => {
      const fn = src.match(/function startQueue\(\) \{[\s\S]*?\n  \}/);
      expect(fn).not.toBeNull();
      expect(fn![0]).toContain("hideQuotaBanner()");
    });
  });

  describe("quota pause/resume (P-quota)", () => {
    const src = getDashboardSrc();

    describe("POST /api/resume route", () => {
      let dashboard: WebDashboard;
      let baseUrl: string;

      afterEach(async () => {
        await dashboard?.close();
      });

      async function setup(handler: (() => boolean) | null | undefined) {
        dashboard = new WebDashboard(0, "/tmp", undefined, "gemini", null, undefined, handler);
        const info = await dashboard.start();
        expect(info).not.toBeNull();
        baseUrl = info!.url;
      }

      const post = async () => {
        const res = await fetch(`${baseUrl}api/resume`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        expect(res.status).toBe(200);
        return (await res.json()) as { ok: boolean; error?: string };
      };

      it("returns {ok:true} and invokes the injected handler when a paused walk is released", async () => {
        const onResumeRequest = vi.fn(() => true);
        await setup(onResumeRequest);
        expect(await post()).toEqual({ ok: true });
        expect(onResumeRequest).toHaveBeenCalledTimes(1);
      });

      it("reports {ok:false} when the handler says nothing is paused", async () => {
        await setup(() => false);
        const json = await post();
        expect(json.ok).toBe(false);
        expect(json.error).toContain("not paused");
      });

      it("mirrors the stop-null pattern with no handler registered", async () => {
        await setup(null);
        const json = await post();
        expect(json.ok).toBe(false);
        expect(json.error).toContain("no paused run");
      });

      it("exposes paused:false in /api/state until setPaused flips it", async () => {
        await setup(undefined);
        expect(((await (await fetch(`${baseUrl}api/state`)).json()) as { paused: boolean }).paused).toBe(false);
        dashboard.setPaused(true, "paused for quota");
        const snap = (await (await fetch(`${baseUrl}api/state`)).json()) as { paused: boolean; notice: string | null };
        expect(snap.paused).toBe(true);
        expect(snap.notice).toBe("paused for quota");
      });
    });

    it("renders the resume button inside the quota banner", () => {
      expect(src).toContain('<button id="resumebtn" hidden>✓ Changed — Resume</button>');
    });

    it("drives the banner from the server-driven snapshot.paused flag (documented choice)", () => {
      const fn = src.match(/function renderPause\(s\) \{[\s\S]*?\n  \}/);
      expect(fn).not.toBeNull();
      expect(fn![0]).toContain("s.paused === true");
      expect(fn![0]).toContain("PAUSED_BANNER_MSG");
      // applyState routes every state broadcast through it
      expect(src.match(/function applyState\(s\) \{[\s\S]*?\n  \}/)![0]).toContain("renderPause(s);");
    });

    it("carries the exact pause banner text", () => {
      expect(src).toContain(
        'var PAUSED_BANNER_MSG = "All models RPD exhausted — change GEMINI_API_KEY, then Resume";',
      );
    });

    it("posts /api/resume optimistically and resyncs when rejected", () => {
      const fn = src.match(/function requestResume\(\) \{[\s\S]*?\n  \}/);
      expect(fn).not.toBeNull();
      expect(fn![0]).toMatch(/btn\.hidden = true/);
      expect(fn![0]).toContain('fetch("/api/resume"');
      expect(fn![0]).toContain("resync()");
    });

    it("fires a browser Notification on pause entry only when already granted, never prompting", () => {
      const fn = src.match(/function notifyPaused\(\) \{[\s\S]*?\n  \}/);
      expect(fn).not.toBeNull();
      expect(fn![0]).toContain('if ("Notification" in window && Notification.permission === "granted")');
      expect(fn![0]).toMatch(/try \{[\s\S]*?Notification[\s\S]*?\} catch \(_\) \{ \}/);
      expect(fn![0]).not.toContain("requestPermission");
    });

    it("wires the resume click through onLoad run-controls", () => {
      const fn = src.match(/function onLoad\(\) \{[\s\S]*?\n  \}/);
      expect(fn!.length).toBeGreaterThan(0);
      expect(fn![0]).toContain('$("resumebtn").addEventListener("click", requestResume)');
    });

    it("keeps Agents/Counters rail panels from compressing into each other (.rail>.panel flex:none)", () => {
      expect(src).toContain(".rail > .panel { flex: none; }");
    });
  });

  describe("always-visible provider bar (CHANGE 1)", () => {
    const src = getDashboardSrc();

    const sliceDiv = (from: number) => src.slice(from, src.indexOf("</div>", from));

    it("#startpanel keeps only run controls — no pickers, providers or stop", () => {
      const sp = sliceDiv(src.indexOf('<div id="startpanel"'));
      expect(sp).toContain('id="repoinput"');
      expect(sp).toContain('id="startbtn"');
      expect(sp).toContain('id="notice"');
      expect(sp).toContain('id="scantimer"');
      expect(sp).not.toContain('id="modelpickers"');
      expect(sp).not.toContain("data-provider=");
      expect(sp).not.toContain('id="stopbtn"');
      expect(sp).not.toContain('id="modelsmsg"');
    });

    it("#providerbar carries pickers, provider buttons and the relocated stop button", () => {
      const idx = src.indexOf('<div id="providerbar"');
      expect(idx).toBeGreaterThan(0);
      const pb = sliceDiv(idx);
      expect(pb).toContain('id="modelpickers"');
      expect(pb).toContain("data-provider=");
      expect(pb).toContain('id="stopbtn"');
      expect(pb).toContain('id="modelsmsg"');
      expect(pb).toMatch(/margin-left:auto[^>]*>Stop/);
    });

    it("#providerbar sits directly after #startpanel and before <main>", () => {
      const spEnd = src.indexOf("</div>", src.indexOf('<div id="startpanel"'));
      const pbIdx = src.indexOf('<div id="providerbar"');
      const mainIdx = src.indexOf("<main>");
      expect(pbIdx).toBeGreaterThan(spEnd);
      expect(pbIdx).toBeLessThan(mainIdx);
    });

    it("syncStartPanel toggles only #startpanel, never the provider bar", () => {
      const fn = src.match(/function syncStartPanel\(\) \{[\s\S]*?\n  \}/);
      expect(fn).not.toBeNull();
      expect(fn![0]).toContain("startpanel");
      expect(fn![0]).not.toContain("providerbar");
    });

    it("renderStop targets #stopbtn by id (location-independent)", () => {
      const fn = src.match(/function renderStop\(\) \{[\s\S]*?\n  \}/);
      expect(fn).not.toBeNull();
      expect(fn![0]).toContain('$("stopbtn")');
    });
  });

  describe("two-stream live transcript (CHANGE 2)", () => {
    const src = getDashboardSrc();

    it("renders side-by-side agent + tools stream columns", () => {
      expect(src).toContain('class="streams"');
      expect(src).toContain('id="agentstream-wrap"');
      expect(src).toContain('id="toolsstream-wrap"');
      expect(src).toContain('id="toolsstream" class="stream-scroll"');
    });

    it("#log stays the agent stream with its original placeholder", () => {
      expect(src).toMatch(/id="log" class="stream-scroll"/);
      expect(src).toContain(">waiting for agent output…</div>");
      expect(src).toContain(">waiting for tool activity…</div>");
    });

    it("one shared renderer feeds BOTH sinks (toolsstream + transcript tab)", () => {
      expect(src).toContain("function renderAgentEvent(ev)");
      const fn = src.match(/function appendAgentEvent\(role, ev\) \{[\s\S]*?\n  \}/);
      expect(fn).not.toBeNull();
      const body = fn![0];
      expect(body.match(/renderAgentEvent\(ev\)/g)?.length).toBeGreaterThanOrEqual(2);
      expect(body).toContain('"toolsstream"');
      expect(body).toContain('"transcript-tab"');
    });

    it("each sink clears its empty placeholder on first real event", () => {
      const fn = src.match(/function appendAgentEvent\(role, ev\) \{[\s\S]*?\n  \}/);
      expect(fn![0]).toContain('.querySelector(".empty")');
      const logFn = src.match(/function appendLogLine\(L\) \{[\s\S]*?\n  \}/);
      expect(logFn![0]).toContain('.empty');
    });
  });

  describe("follow-scroll manager (CHANGE 4)", () => {
    const src = getDashboardSrc();

    // eslint-disable-next-line no-eval
    const computeNextStick = eval(
      "(function(){ var FOLLOW_RELEASE_PX = 40, FOLLOW_RESTICK_PX = 8; " +
        src.match(/function computeNextStick\(stick, scrollTop, scrollHeight, clientHeight\) \{[\s\S]*?\n  \}/)![0] +
        " return computeNextStick; })",
    )() as (
      stick: boolean,
      scrollTop: number,
      scrollHeight: number,
      clientHeight: number,
    ) => boolean;

    it("keeps the 40px release / 8px restick constants plus pill + glow artifacts", () => {
      expect(src).toContain("FOLLOW_RELEASE_PX = 40");
      expect(src).toContain("FOLLOW_RESTICK_PX = 8");
      expect(src).toContain("edge-glow");
      expect(src).toContain('"▼ follow"');
      expect(src).toContain('className = "follow-pill"');
    });

    it("computeNextStick resticks within 8px of the bottom", () => {
      expect(computeNextStick(false, 95, 100, 10)).toBe(true);
      expect(computeNextStick(true, 94, 100, 10)).toBe(true);
    });

    it("computeNextStick releases past 40px from the bottom", () => {
      expect(computeNextStick(true, 0, 200, 100)).toBe(false);
    });

    it("computeNextStick holds current state in the hysteresis band", () => {
      expect(computeNextStick(true, 60, 200, 100)).toBe(true);
      expect(computeNextStick(false, 60, 200, 100)).toBe(false);
    });

    it("installs on both streams, the rail wrapper and every tab panel", () => {
      const fn = src.match(/function installFollowScroll\(\) \{[\s\S]*?\n  \}/);
      expect(fn).not.toBeNull();
      expect(fn![0]).toContain('"log"');
      expect(fn![0]).toContain('"toolsstream"');
      expect(fn![0]).toContain('"railwrap"');
      expect(fn![0]).toContain(".tab-content");
    });

    it("appends snap via rAF when stuck and pulse edge-glow when not", () => {
      const fn = src.match(/function followAppend\(el\) \{[\s\S]*?\n  \}/);
      expect(fn).not.toBeNull();
      expect(fn![0]).toContain("requestAnimationFrame");
      expect(fn![0]).toContain("followGlow(el, st)");
    });

    it("legacy per-pane stick flags are gone", () => {
      expect(src).not.toContain("stickLog");
      expect(src).not.toContain("stickTranscript");
    });
  });

  describe("onLoad boot resilience (CHANGE 5)", () => {
    const src = getDashboardSrc();

    it("defines a safe(name, fn) init wrapper", () => {
      expect(src).toContain("function safe(name, fn)");
      expect(src).toContain('"[dash:init]"');
    });

    it("wraps at least five independent init chunks in onLoad", () => {
      const fn = src.match(/function onLoad\(\) \{[\s\S]*?\n  \}/);
      expect(fn).not.toBeNull();
      expect(fn![0].match(/safe\(/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
    });

    it("runs the /api/state + SSE bootstrap outside safe(), after all chunks", () => {
      const fn = src.match(/function onLoad\(\) \{[\s\S]*?\n  \}/)!;
      const lastSafe = fn[0].lastIndexOf("safe(");
      const boot = fn[0].indexOf('fetch("/api/state")');
      expect(boot).toBeGreaterThan(lastSafe);
      expect(fn[0]).toContain("startSSE()");
    });
  });
});

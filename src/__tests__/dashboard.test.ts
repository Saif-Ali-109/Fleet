import { readFileSync } from "node:fs";
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { newDashboardState, renderDashboard } from "../tui/dashboard.ts";
import { WebDashboard, type WebhookResponse } from "../dashboard/webDashboard.ts";
import { availableModels } from "../models/modelPolicy.ts";
import { listModelsForProvider } from "../providers/registry.ts";
import type { ProviderName, Role } from "../types.ts";

vi.mock("../providers/registry.ts", () => ({
  listModelsForProvider: vi.fn(async () => [] as string[]),
}));

const listModelsMock = vi.mocked(listModelsForProvider);

const ROLES: Role[] = ["analyzer", "planner", "coder", "tester", "reviewer", "pr"];

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
    const src = readFileSync(
      new URL("../dashboard/webDashboard.ts", import.meta.url),
      "utf8",
    );

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
      const res = await fetch(`${baseUrl}api/models?provider=openrouter`);
      expect(res.status).toBe(200);
      const json = await res.json() as { models: Record<string, string>; available: string[] };
      expect(json.available).toEqual(["zeta/one", "alpha/two"]);
      expect(json.models).toEqual({});
      expect(listModelsMock).toHaveBeenCalledWith("openrouter");
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
    const src = readFileSync(
      new URL("../dashboard/webDashboard.ts", import.meta.url),
      "utf8",
    );
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
    const src = readFileSync(
      new URL("../dashboard/webDashboard.ts", import.meta.url),
      "utf8",
    );

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
});

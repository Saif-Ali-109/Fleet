import type { IncomingMessage, ServerResponse } from "node:http";
import type { DashboardState } from "../tui/dashboard.ts";
import type { ProviderName, Role } from "../types.ts";
import { PROVIDER_NAMES } from "../types.ts";
import { ghAuthInfo, type GhAuthInfo } from "../github/gh.ts";
import { startDeviceLogin, pollDeviceToken, storeGhToken } from "../github/gh.ts";
import {
  availableModels,
  getModelOverrides,
  setModelOverride,
  saveModelOverrides,
} from "../models/modelPolicy.ts";
import { listModelsForProvider } from "../providers/registry.ts";
import { MANAGER_ID } from "../telemetry.ts";
import type { QuotaEvent } from "../fleet/quotaEvents.ts";
import { resolveManagerPath } from "../memory/paths.ts";

export interface WebhookResponse { status: number; body?: unknown }
export type WebhookHandler = (headers: Record<string, string | string[] | undefined>, rawBody: string) => Promise<WebhookResponse>;

const WEBHOOK_MAX_BYTES = 256 * 1024;
const MODEL_LIST_TIMEOUT_MS = 10_000;

/** Live provider model ids, or [] when listing fails or hangs past the timeout. */
async function listLiveModels(provider: ProviderName): Promise<string[]> {
  return new Promise<string[]>((resolve) => {
    const timer = setTimeout(() => resolve([]), MODEL_LIST_TIMEOUT_MS);
    void listModelsForProvider(provider)
      .then((ids) => {
        clearTimeout(timer);
        resolve(ids);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve([]);
      });
  });
}

/** Live model ids for the picker, deduped; static SPEC §5 tier defaults as offline fallback. */
async function modelPickerList(provider: ProviderName): Promise<string[]> {
  const live = await listLiveModels(provider);
  if (live.length === 0) return [...availableModels(provider)];
  return [...new Set(live)];
}

export class ApiHandlers {
  private readonly port: number;
  private readonly rootDir: string;
  private onStartRequest: ((repo: string, provider: ProviderName) => Promise<{ ok: boolean; error?: string; runStarted?: boolean }>) | null = null;
  private onStopRequest: (() => void) | null = null;
  private onWebhook: WebhookHandler | null = null;
  private onResumeRequest: (() => boolean) | null = null;
  private onTelemetry: ((event: Record<string, unknown>) => void) | null = null;
  private runActive = false;
  private stopRequested = false;
  private paused = false;
  private notice: string | null = null;
  private nextScanAt: number | null = null;
  public errorLog: Array<{ type: string; message: string; agent: string; issue?: number; timestamp: number }> = [];
  private loginInProgress = false;
  public provider: ProviderName = "gemini";
  private dash: DashboardState | null = null;
  private outputs: Record<Role, string[]> = {
    analyzer: [],
    planner: [],
    coder: [],
    tester: [],
    reviewer: [],
    pr: [],
  };
  private agentEvents: Record<Role, Record<string, unknown>[]> = {
    analyzer: [],
    planner: [],
    coder: [],
    tester: [],
    reviewer: [],
    pr: [],
  };
  private gh: GhAuthInfo | null = null;

  constructor(
    port: number,
    rootDir: string,
    onStartRequest?: (repo: string, provider: ProviderName) => Promise<{ ok: boolean; error?: string; runStarted?: boolean }>,
    initialProvider: ProviderName = "gemini",
    onStopRequest: (() => void) | null = null,
    onWebhook?: WebhookHandler,
    onResumeRequest?: (() => boolean) | null,
    onTelemetry?: (event: Record<string, unknown>) => void,
  ) {
    this.port = port;
    this.rootDir = rootDir;
    this.onStartRequest = onStartRequest ?? null;
    this.provider = initialProvider;
    this.onStopRequest = onStopRequest;
    this.onWebhook = onWebhook ?? null;
    this.onResumeRequest = onResumeRequest ?? null;
    this.onTelemetry = onTelemetry ?? null;
  }

  /** Answer CORS preflight so a browser can still POST after the JSON-only rule below. */
  handlePreflight(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin;
    res.writeHead(204, {
      "Access-Control-Allow-Origin": origin ?? "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    });
    res.end();
  }

  /** CSRF guard: mutating POSTs must be JSON and come from the local dashboard host. */
  guardMutation(req: IncomingMessage, res: ServerResponse): boolean {
    const origin = req.headers.origin;
    if (origin !== undefined) {
      let o: URL;
      try {
        o = new URL(origin);
      } catch {
        this.sendJson(res, 403, { ok: false, error: "forbidden: bad Origin header" });
        return false;
      }
      if (o.hostname !== "127.0.0.1" && o.hostname !== "localhost") {
        this.sendJson(res, 403, { ok: false, error: "forbidden: origin not allowed" });
        return false;
      }
    }
    const host = req.headers.host ?? "";
    const hostName = host.split(":")[0];
    if (hostName !== "127.0.0.1" && hostName !== "localhost") {
      this.sendJson(res, 403, { ok: false, error: "forbidden: bad Host header" });
      return false;
    }
    const rawCt = req.headers["content-type"];
    const ct = (Array.isArray(rawCt) ? rawCt[0] : rawCt) ?? "";
    if (ct.split(";")[0].trim() !== "application/json") {
      this.sendJson(res, 415, { ok: false, error: "content-type must be application/json" });
      return false;
    }
    return true;
  }

  handleStart(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let done = false;
    const maxBytes = 8 * 1024;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        done = true;
        this.sendJson(res, 413, { ok: false, error: "body too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        this.sendJson(res, 400, { ok: false, error: "invalid JSON body" });
        return;
      }
      const repo = (body as { repo?: unknown }).repo;
      if (typeof repo !== "string" || repo.trim() === "") {
        this.sendJson(res, 400, { ok: false, error: "missing repo" });
        return;
      }
      const rawProvider = (body as { provider?: unknown }).provider;
      const provider =
        typeof rawProvider === "string" && (PROVIDER_NAMES as readonly string[]).includes(rawProvider)
          ? (rawProvider as ProviderName)
          : this.provider;
      if (this.runActive) {
        this.sendJson(res, 200, { ok: false, error: "a run is already in progress" });
        return;
      }
      this.stopRequested = false;
      this.runActive = true;
      if (!this.onStartRequest) {
        this.runActive = false;
        this.stopRequested = false;
        this.sendJson(res, 200, { ok: false, error: "no start handler registered" });
        return;
      }
      void this.onStartRequest(repo, provider)
        .then((result) => {
          this.sendJson(res, 200, result);
          if (!result.ok || !result.runStarted) {
            this.runActive = false;
            this.stopRequested = false;
          }
        })
        .catch((err) => {
          this.runActive = false;
          this.stopRequested = false;
          this.sendJson(res, 200, {
            ok: false,
            error: String(err instanceof Error ? err.message : err),
          });
        });
    });
    req.on("error", () => {
      if (!done) {
        done = true;
        this.sendJson(res, 400, { ok: false, error: "request error" });
      }
    });
  }

  handleStop(res: ServerResponse): void {
    if (!this.onStopRequest) {
      this.sendJson(res, 200, { ok: false, error: "no run to stop" });
      return;
    }
    this.runActive = false;
    this.stopRequested = true;
    this.onStopRequest();
    // Note: Broadcast is handled by the dashboard core
    this.sendJson(res, 200, { ok: true });
  }

  /** POST /api/resume — key-change resume click (SPEC §11.5); mirrors the stop-null pattern. */
  handleResume(res: ServerResponse): void {
    if (!this.onResumeRequest) {
      this.sendJson(res, 200, { ok: false, error: "no paused run to resume" });
      return;
    }
    const delivered = this.onResumeRequest();
    if (!delivered) {
      this.sendJson(res, 200, { ok: false, error: "run is not paused" });
      return;
    }
    this.paused = false;
    // Note: Broadcast is handled by the dashboard core
    this.sendJson(res, 200, { ok: true });
  }

  handleWebhook(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let done = false;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > WEBHOOK_MAX_BYTES) {
        done = true;
        this.sendJson(res, 413, { error: "body too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      const rawBody = Buffer.concat(chunks).toString("utf8");
      if (!this.onWebhook) {
        this.sendJson(res, 503, { error: "webhook not configured" });
        return;
      }
      void this.onWebhook(req.headers as Record<string, string | string[] | undefined>, rawBody)
        .then((result) => {
          this.sendJson(res, result.status, result.body ?? { ok: true });
        })
        .catch((err) => {
          this.sendJson(res, 500, { error: String(err instanceof Error ? err.message : err) });
        });
    });
    req.on("error", () => {
      if (!done) {
        done = true;
        this.sendJson(res, 400, { error: "request error" });
      }
    });
  }

  handleModelLimitError(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let done = false;
    const maxBytes = 8 * 1024;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        done = true;
        this.sendJson(res, 413, { ok: false, error: "body too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        this.sendJson(res, 400, { ok: false, error: "invalid JSON body" });
        return;
      }
      const { type, message, agent, issue, timestamp } = body as {
        type: string;
        message: string;
        agent: string;
        issue?: number;
        timestamp: number;
      };
      if (typeof type !== "string" || typeof message !== "string" || typeof agent !== "string") {
        this.sendJson(res, 400, { ok: false, error: "missing or invalid fields" });
        return;
      }
      // Store in error log (max 50, FIFO)
      this.errorLog.push({ type, message, agent, issue, timestamp: timestamp ?? Date.now() });
      if (this.errorLog.length > 50) this.errorLog.shift();
      // Note: Broadcast is handled by the dashboard core
      this.sendJson(res, 202, { ok: true });
    });
    req.on("error", () => {
      if (!done) {
        done = true;
        this.sendJson(res, 400, { ok: false, error: "request error" });
      }
    });
  }

  /** GET /api/models?provider=X — live model list, static tier defaults when the provider is unreachable. */
  async sendModels(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://127.0.0.1`);
    const raw = url.searchParams.get("provider");
    const provider =
      raw !== null && (PROVIDER_NAMES as readonly string[]).includes(raw)
        ? (raw as ProviderName)
        : this.provider;
    const available = await this.observedModelList(provider);
    const envModels: Record<string, string> = {};
    const roles: Role[] = ["analyzer", "planner", "coder", "tester", "reviewer", "pr"];
    for (const role of roles) {
      const envKey = `${role.toUpperCase()}_MODEL_${provider.toUpperCase()}`;
      const rawVal = process.env[envKey];
      if (typeof rawVal === "string" && rawVal.length > 0) envModels[role] = rawVal;
    }
    this.sendJson(res, 200, {
      models: getModelOverrides()[provider] ?? {},
      envModels,
      available,
      trafficClass: "metadata",
      generationReservation: false,
    });
  }

  handleModels(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let done = false;
    const maxBytes = 8 * 1024;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        done = true;
        this.sendJson(res, 413, { ok: false, error: "body too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        this.sendJson(res, 400, { ok: false, error: "invalid JSON body" });
        return;
      }
      const role = (body as { role?: unknown }).role;
      const model = (body as { model?: unknown }).model;
      const rawProvider = (body as { provider?: unknown }).provider;
      const provider =
        typeof rawProvider === "string" && (PROVIDER_NAMES as readonly string[]).includes(rawProvider)
          ? (rawProvider as ProviderName)
          : this.provider;
      if (typeof role !== "string" || !["analyzer", "planner", "coder", "tester", "reviewer", "pr"].includes(role as Role)) {
        this.sendJson(res, 400, { ok: false, error: "invalid role" });
        return;
      }
      if (typeof model !== "string" || !model.trim()) {
        this.sendJson(res, 400, { ok: false, error: "invalid model" });
        return;
      }
      if (this.runActive) {
        this.sendJson(res, 409, { ok: false, error: "a run is in progress; cannot change models" });
        return;
      }
      try {
        setModelOverride(role as Role, model, provider);
      } catch (err) {
        this.sendJson(res, 400, { ok: false, error: String(err instanceof Error ? err.message : err) });
        return;
      }
      try {
        saveModelOverrides(resolveManagerPath(this.rootDir, "models.json"));
      } catch (err) {
        this.sendJson(res, 500, {
          ok: false,
          error: "failed to persist model overrides: " + String(err instanceof Error ? err.message : err),
        });
        return;
      }
      const models = getModelOverrides()[provider] ?? {};
      this.sendJson(res, 200, {
        ok: true,
        models,
        trafficClass: "metadata",
        generationReservation: false,
      });
      void this.observedModelList(provider).then((available) => {
        // Note: Broadcast is handled by the dashboard core
      });
    });
    req.on("error", () => {
      if (!done) {
        done = true;
        this.sendJson(res, 400, { ok: false, error: "request error" });
      }
    });
  }

  /** Set the run provider (gemini | openrouter | ollama) used for the next queue start. */
  handleProvider(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    let done = false;
    let bytes = 0;
    const maxBytes = 8 * 1024;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        done = true;
        this.sendJson(res, 413, { ok: false, error: "body too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        this.sendJson(res, 400, { ok: false, error: "invalid JSON body" });
        return;
      }
      const provider = (body as { provider?: unknown }).provider;
      if (typeof provider !== "string" || !(PROVIDER_NAMES as readonly string[]).includes(provider)) {
        this.sendJson(res, 400, { ok: false, error: `invalid provider; must be one of: ${PROVIDER_NAMES.join(", ")}` });
        return;
      }
      if (this.runActive) {
        this.sendJson(res, 409, { ok: false, error: "a run is in progress; cannot change provider" });
        return;
      }
      this.provider = provider as ProviderName;
      // Note: Broadcast is handled by the dashboard core
      this.sendJson(res, 200, { ok: true, provider: this.provider });
    });
    req.on("error", () => {
      if (!done) {
        done = true;
        this.sendJson(res, 400, { ok: false, error: "request error" });
      }
    });
  }

  /** Run the GitHub device-flow login from the server and stream status to SSE. */
  handleLogin(res: ServerResponse): void {
    if (this.loginInProgress) {
      this.sendJson(res, 200, { ok: false, error: "a login is already in progress" });
      return;
    }
    this.loginInProgress = true;
    void (async () => {
      const info = await ghAuthInfo();
      if (info.ok) {
        // Note: pushGh is handled by the dashboard core
        this.sendJson(res, 200, { ok: true, status: "done", username: info.username });
        this.loginInProgress = false;
        return;
      }
      try {
        const req = await startDeviceLogin();
        this.sendJson(res, 200, {
          ok: true,
          status: "pending",
          userCode: req.userCode,
          verificationUri: req.verificationUri,
          interval: req.interval,
        });
        const token = await pollDeviceToken(req.deviceCode, req.interval);
        await storeGhToken(token);
        const after = await ghAuthInfo();
        // Note: pushGh and pushNotice are handled by the dashboard core
        this.sendJson(res, 200, { ok: true, status: "done", username: after.username });
        this.loginInProgress = false;
      } catch (err: any) {
        const message = err instanceof Error ? err.message : String(err);
        // Note: pushGh and pushNotice are handled by the dashboard core
        this.loginInProgress = false;
        this.sendJson(res, 200, { ok: false, error: message });
      }
    })();
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    try {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      res.end(JSON.stringify(body));
    } catch {
      // socket already destroyed
    }
  }

  private async sendFile(res: ServerResponse, filePath: string): Promise<void> {
    // Note: This is kept here for potential use by API handlers, though currently not used
    try {
      const { existsSync } = await import("node:fs");
      const { readFile } = await import("node:fs/promises");
      const { resolve } = await import("node:path");

      if (!existsSync(filePath)) {
        this.sendJson(res, 200, { content: "" });
        return;
      }
      const content = await readFile(filePath, "utf8");
      this.sendJson(res, 200, { content });
    } catch {
      this.sendJson(res, 500, { error: "failed to read file" });
    }
  }

  // These would need to be implemented by the dashboard core to maintain state
  private async observedModelList(provider: ProviderName): Promise<string[]> {
    const { randomUUID } = await import("node:crypto");
    const requestId = randomUUID();
    const base = {
      t: "telemetry",
      event: "metadata_model_discovery",
      managerId: MANAGER_ID,
      provider,
      requestId,
      timestamp: new Date().toISOString(),
      trafficClass: "metadata",
      generationReservation: false,
    } as const;
    this.onTelemetry?.({ ...base, status: "started" });
    const available = await modelPickerList(provider);
    this.onTelemetry?.({ ...base, status: "completed", count: available.length });
    return available;
  }

  // Setters for state that would be managed by the dashboard core
  setRunActive(active: boolean) {
    this.runActive = active;
  }

  setStopRequested(requested: boolean) {
    this.stopRequested = requested;
  }

  setPaused(paused: boolean) {
    this.paused = paused;
  }

  setNotice(notice: string | null) {
    this.notice = notice;
  }

  setNextScanAt(ts: number | null) {
    this.nextScanAt = ts;
  }

  setErrorLog(log: Array<{ type: string; message: string; agent: string; issue?: number; timestamp: number }>) {
    this.errorLog = log;
  }

  setGh(info: GhAuthInfo | null) {
    this.gh = info;
  }

  setDash(dash: DashboardState | null) {
    this.dash = dash;
  }

  setOutputs(outputs: Record<Role, string[]>) {
    this.outputs = outputs;
  }

  setAgentEvents(events: Record<Role, Record<string, unknown>[]>) {
    this.agentEvents = events;
  }

  getSnapshot() {
    return {
      dash: this.dash,
      outputs: this.outputs,
      agentEvents: this.agentEvents,
      gh: this.gh,
      notice: this.notice,
      nextScanAt: this.nextScanAt,
      runActive: this.runActive,
      queueMode: this.onStartRequest !== null,
      provider: this.provider,
      stopRequested: this.stopRequested,
      paused: this.paused,
      errorLog: this.errorLog
    };
  }
}
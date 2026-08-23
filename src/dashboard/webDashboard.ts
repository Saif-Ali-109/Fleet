// Live local web dashboard — zero runtime deps, Node built-ins only.
// Serves a self-contained HTML page (no CDN, no build step), JSON state,
// and a Server-Sent Events feed. Strictly a read-only mirror of the terminal TUI.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveManagerPath } from "../memory/paths.ts";
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

export interface WebhookResponse { status: number; body?: unknown }
export type WebhookHandler = (headers: Record<string, string | string[] | undefined>, rawBody: string) => Promise<WebhookResponse>;

const DEFAULT_PORT = 3456;
const HOST = "127.0.0.1";
const MAX_CHUNKS = 200;
const MAX_BYTES = 30 * 1024;
const HEARTBEAT_MS = 25_000;
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

interface SseClient {
  res: ServerResponse;
  timer: NodeJS.Timeout;
}

const ROLES: Role[] = ["analyzer", "planner", "coder", "tester", "reviewer", "pr"];

const EMPTY_OUTPUTS: Record<Role, string[]> = {
  analyzer: [],
  planner: [],
  coder: [],
  tester: [],
  reviewer: [],
  pr: [],
};

export class WebDashboard {
  private readonly port: number;
  private readonly rootDir: string;
  private onStartRequest: ((repo: string, provider: ProviderName) => Promise<{ ok: boolean; error?: string; runStarted?: boolean }>) | null = null;
  private onStopRequest: (() => void) | null = null;
  private onWebhook: WebhookHandler | null = null;
  private runActive = false;
  private stopRequested = false;
  private notice: string | null = null;
  private nextScanAt: number | null = null;
  private errorLog: Array<{ type: string; message: string; agent: string; issue?: number; timestamp: number }> = [];
  private loginInProgress = false;
  private provider: ProviderName = "gemini";
  private server: Server | null = null;
  private clients = new Map<ServerResponse, SseClient>();
  private lastEventId = 0;
  private dash: DashboardState | null = null;
  private outputs: Record<Role, string[]> = { ...EMPTY_OUTPUTS };
  private gh: GhAuthInfo | null = null;
  private agentEvents: Record<Role, Record<string, unknown>[]> = { ...EMPTY_OUTPUTS } as unknown as Record<Role, Record<string, unknown>[]>;

  constructor(
    port: number = DEFAULT_PORT,
    rootDir: string,
    onStartRequest?: (repo: string, provider: ProviderName) => Promise<{ ok: boolean; error?: string; runStarted?: boolean }>,
    initialProvider: ProviderName = "gemini",
    onStopRequest: (() => void) | null = null,
    onWebhook?: WebhookHandler,
  ) {
    this.port = port;
    this.rootDir = rootDir;
    this.onStartRequest = onStartRequest ?? null;
    this.provider = initialProvider;
    this.onStopRequest = onStopRequest;
    this.onWebhook = onWebhook ?? null;
  }

  /** Bind the HTTP server. Resolves `null` (never throws) when the port is unavailable. */
  async start(): Promise<{ url: string; port: number } | null> {
    const server = createServer((req, res) => this.handle(req, res));
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.port, HOST, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
    } catch (err) {
      this.server = null;
      const code = (err as NodeJS.ErrnoException)?.code;
      const reason =
        code === "EADDRINUSE"
          ? `${HOST}:${this.port} already in use`
          : String(err instanceof Error ? err.message : err);
      console.error(`\n⚠ Web dashboard disabled: ${reason}`);
      return null;
    }
    server.on("error", (err) => {
      console.error(`Web dashboard server error: ${err.message}`);
    });
    server.on("clientError", (_err, socket) => {
      try {
        socket.destroy();
      } catch {
        // socket already gone
      }
    });
    const addr = server.address();
    const boundPort = typeof addr === "object" && addr !== null ? addr.port : this.port;
    return { url: `http://${HOST}:${boundPort}/`, port: boundPort };
  }

  /** Store the latest dashboard state and broadcast it to every SSE client. */
  pushState(dash: DashboardState): void {
    this.dash = dash;
    this.lastEventId += 1;
    this.broadcast(this.lastEventId, "state", this.snapshot());
  }

  /** Set a terminal phase (+ optional PR url) on the latest dash state and broadcast it. No-op before a run starts. */
  pushFinal(phase: DashboardState["phase"], prUrl?: string): void {
    if (!this.dash) return;
    this.runActive = false;
    this.stopRequested = false;
    this.dash.phase = phase;
    if (prUrl !== undefined) this.dash.prUrl = prUrl;
    this.lastEventId += 1;
    this.broadcast(this.lastEventId, "state", this.snapshot());
  }

  /** Store gh auth info and broadcast it to every SSE client. */
  pushGh(info: GhAuthInfo): void {
    this.gh = info;
    this.lastEventId += 1;
    this.broadcast(this.lastEventId, "gh", info);
  }

  /** Store a status/notice line and broadcast it with the state snapshot. */
  pushNotice(msg: string): void {
    this.notice = msg;
    this.lastEventId += 1;
    this.broadcast(this.lastEventId, "state", this.snapshot());
  }

  /** Publish/clear the next daemon scan deadline (epoch ms) for the live countdown. */
  pushNextScanAt(ts: number | null): void {
    this.nextScanAt = ts;
    this.lastEventId += 1;
    this.broadcast(this.lastEventId, "state", this.snapshot());
  }

  /** Append a live text chunk for `role` (capped) and broadcast it. */
  pushOutput(role: Role, text: string): void {
    const arr = this.outputs[role];
    if (arr) {
      arr.push(text);
      while (arr.length > MAX_CHUNKS) arr.shift();
      let bytes = 0;
      for (const chunk of arr) bytes += chunk.length;
      while (bytes > MAX_BYTES && arr.length > 1) {
        const dropped = arr.shift();
        if (dropped !== undefined) bytes -= dropped.length;
      }
    }
    this.lastEventId += 1;
    const id = this.lastEventId;
    this.broadcast(id, "output", { role, text, lastEventId: id });
  }

  /** Broadcast an agent stream event (thinking, tool call, result, etc.). */
  pushAgentEvent(role: Role, event: Record<string, unknown>): void {
    const arr = this.agentEvents[role];
    if (arr) {
      arr.push(event);
      while (arr.length > MAX_CHUNKS) arr.shift();
    }
    this.lastEventId += 1;
    this.broadcast(this.lastEventId, "agent-event", { role, event });
  }


  /** Stop the server and close all SSE clients. Safe to call more than once. */
  async close(): Promise<void> {
    for (const res of [...this.clients.keys()]) this.dropClient(res);
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  }

  private broadcast(id: number, event: string, data: unknown): void {
    const frame = `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const { res } of this.clients.values()) {
      try {
        res.write(frame);
      } catch {
        this.dropClient(res);
      }
    }
  }

  private snapshot(): {
    dash: DashboardState | null;
    outputs: Record<Role, string[]>;
    agentEvents: Record<Role, Record<string, unknown>[]>;
    gh: GhAuthInfo | null;
    notice: string | null;
    nextScanAt: number | null;
    runActive: boolean;
    queueMode: boolean;
    provider: ProviderName;
    stopRequested: boolean;
    errorLog: Array<{ type: string; message: string; agent: string; issue?: number; timestamp: number }>;
  } {
    return { dash: this.dash, outputs: this.outputs, agentEvents: this.agentEvents, gh: this.gh, notice: this.notice, nextScanAt: this.nextScanAt, runActive: this.runActive, queueMode: this.onStartRequest !== null, provider: this.provider, stopRequested: this.stopRequested, errorLog: this.errorLog };
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const path = new URL(req.url ?? "/", `http://${HOST}`).pathname;
    if (req.method === "OPTIONS") {
      this.handlePreflight(req, res);
      return;
    }
    if (req.method === "POST") {
      if (path === "/webhook") {
        this.handleWebhook(req, res);
        return;
      }
      if (!this.guardMutation(req, res)) return;
      if (path === "/api/start") {
        this.handleStart(req, res);
        return;
      }
      if (path === "/api/stop") {
        this.handleStop(res);
        return;
      }
      if (path === "/api/login") {
        this.handleLogin(res);
        return;
      }
      if (path === "/api/models") {
        this.handleModels(req, res);
        return;
      }
      if (path === "/api/provider") {
        this.handleProvider(req, res);
        return;
      }
      if (path === "/api/model-limit-error") {
        this.handleModelLimitError(req, res);
        return;
      }
    }
    if ((req.method ?? "GET") !== "GET") {
      this.sendJson(res, 404, { error: "not found" });
      return;
    }
    if (path === "/") {
      this.sendHtml(res);
      return;
    }
    if (path === "/api/health") {
      this.sendJson(res, 200, { ok: true });
      return;
    }
    if (path === "/api/gh") {
      void ghAuthInfo().then((info) => this.sendJson(res, 200, info));
      return;
    }
    if (path === "/api/state") {
      this.sendJson(res, 200, this.snapshot());
      return;
    }
    if (path === "/api/models") {
      void this.sendModels(req, res);
      return;
    }
    if (path === "/api/provider") {
      this.sendJson(res, 200, { provider: this.provider, providers: [...PROVIDER_NAMES] });
      return;
    }
    if (path === "/api/events") {
      this.openSse(req, res);
      return;
    }
    if (path === "/api/memory") {
      void this.sendFile(res, resolveManagerPath(this.rootDir, "MEMORY.md"));
      return;
    }
    if (path === "/api/model-limit-error") {
      this.sendJson(res, 200, { ok: true, errorLog: this.errorLog });
      return;
    }
    if (path === "/api/session-log") {
      void this.sendFile(res, resolveManagerPath(this.rootDir, "SESSION_LOG.md"));
      return;
    }
    this.sendJson(res, 404, { error: "not found" });
  }

  /** Answer CORS preflight so a browser can still POST after the JSON-only rule below. */
  private handlePreflight(req: IncomingMessage, res: ServerResponse): void {
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
  private guardMutation(req: IncomingMessage, res: ServerResponse): boolean {
    const origin = req.headers.origin;
    if (origin !== undefined) {
      let o: URL;
      try {
        o = new URL(origin);
      } catch {
        this.sendJson(res, 403, { ok: false, error: "forbidden: bad Origin header" });
        return false;
      }
      if (o.hostname !== HOST && o.hostname !== "localhost") {
        this.sendJson(res, 403, { ok: false, error: "forbidden: origin not allowed" });
        return false;
      }
    }
    const host = req.headers.host ?? "";
    const hostName = host.split(":")[0];
    if (hostName !== HOST && hostName !== "localhost") {
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

  private handleStart(req: IncomingMessage, res: ServerResponse): void {
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

  private handleStop(res: ServerResponse): void {
    if (!this.onStopRequest) {
      this.sendJson(res, 200, { ok: false, error: "no run to stop" });
      return;
    }
    this.runActive = false;
    this.stopRequested = true;
    this.onStopRequest();
    this.lastEventId += 1;
    this.broadcast(this.lastEventId, "state", this.snapshot());
    this.sendJson(res, 200, { ok: true });
  }

  private handleWebhook(req: IncomingMessage, res: ServerResponse): void {
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
  private handleModelLimitError(req: IncomingMessage, res: ServerResponse): void {
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
      // Broadcast updated state to all SSE clients
      this.lastEventId += 1;
      this.broadcast(this.lastEventId, "state", this.snapshot());
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
  private async sendModels(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${HOST}`);
    const raw = url.searchParams.get("provider");
    const provider =
      raw !== null && (PROVIDER_NAMES as readonly string[]).includes(raw)
        ? (raw as ProviderName)
        : this.provider;
    const available = await modelPickerList(provider);
    this.sendJson(res, 200, { models: getModelOverrides()[provider] ?? {}, available });
  }

  private handleModels(req: IncomingMessage, res: ServerResponse): void {
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
      if (typeof role !== "string" || !ROLES.includes(role as Role)) {
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
      this.sendJson(res, 200, { ok: true, models });
      void modelPickerList(provider).then((available) => {
        this.lastEventId += 1;
        this.broadcast(this.lastEventId, "models", {
          provider,
          models,
          available,
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

  /** Set the run provider (gemini | openrouter | ollama) used for the next queue start. */
  private handleProvider(req: IncomingMessage, res: ServerResponse): void {
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
      this.lastEventId += 1;
      this.broadcast(this.lastEventId, "provider", { provider: this.provider, providers: [...PROVIDER_NAMES] });
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
  private handleLogin(res: ServerResponse): void {
    if (this.loginInProgress) {
      this.sendJson(res, 200, { ok: false, error: "a login is already in progress" });
      return;
    }
    this.loginInProgress = true;
    void (async () => {
      const info = await ghAuthInfo();
      if (info.ok) {
        this.pushGh(info);
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
        this.pushGh(after);
        this.pushNotice(after.ok ? `Signed in as @${after.username}` : `Token stored but gh check failed: ${after.error}`);
      } catch (err: any) {
        const message = err instanceof Error ? err.message : String(err);
        this.pushGh({ ok: false, error: message });
        this.pushNotice(`Login failed: ${message}`);
      } finally {
        this.loginInProgress = false;
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
    try {
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

  private sendHtml(res: ServerResponse): void {
    try {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      res.end(HTML);
    } catch {
      // socket already destroyed
    }
  }

  private openSse(req: IncomingMessage, res: ServerResponse): void {
    try {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(": connected\n\n");
    } catch {
      return;
    }
    this.lastEventId += 1;
    const id = this.lastEventId;
    try {
      res.write(`id: ${id}\nevent: snapshot\ndata: ${JSON.stringify(this.snapshot())}\n\n`);
    } catch {
      return;
    }
    const timer = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        this.dropClient(res);
      }
    }, HEARTBEAT_MS);
    this.clients.set(res, { res, timer });
    req.on("close", () => this.dropClient(res));
    res.on("close", () => this.dropClient(res));
    res.on("error", () => this.dropClient(res));
    res.socket?.on("error", () => this.dropClient(res));
  }

  private dropClient(res: ServerResponse): void {
    const client = this.clients.get(res);
    if (client) {
      clearInterval(client.timer);
      this.clients.delete(res);
    }
    try {
      res.end();
    } catch {
      // socket already gone
    }
  }
}

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Multi-Orchestration · Live Dashboard</title>
<style>
:root {
  --bg: #0d1117; --panel: #161b22; --panel2: #1c2129; --border: #2d333b;
  --text: #e6edf3; --muted: #8b949e; --accent: #4fc3f7; --green: #3fb950;
  --red: #f85149;
}
* { box-sizing: border-box; }
[hidden] { display: none; }
html, body { height: 100%; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 14px/1.5 "SF Mono", Menlo, Consolas, monospace; }
header { padding: 14px 20px; border-bottom: 1px solid var(--border);
  display: flex; flex-wrap: wrap; gap: 8px 20px; align-items: baseline; }
header h1 { font-size: 16px; margin: 0; }
.conn { font-size: 12px; padding: 2px 10px; border-radius: 10px; }
.conn.live { color: var(--green); background: rgba(63,185,80,.12); }
.conn.dead { color: var(--red); background: rgba(248,81,73,.12); }
.meta { color: var(--muted); font-size: 12px; }
.gh { font-size: 12px; padding: 2px 10px; border-radius: 10px; color: var(--muted);
  border: 1px solid var(--border); }
.gh.ok { color: var(--green); background: rgba(63,185,80,.12);
  border-color: rgba(63,185,80,.35); }
.gh.missing { color: var(--red); background: rgba(248,81,73,.12);
  border-color: rgba(248,81,73,.35); }
.gh-banner:not([hidden]) { padding: 10px 20px; background: rgba(248,81,73,.12);
   border-bottom: 1px solid var(--red); display: flex; flex-wrap: wrap;
   align-items: center; gap: 8px 14px; font-size: 13px; }
.gh-banner .ghb-title { color: var(--red); font-weight: 600; }
.gh-banner code { background: var(--panel2); border: 1px solid var(--border);
  padding: 2px 8px; border-radius: 4px; color: var(--text); }
.gh-banner button { background: var(--panel2); color: var(--text);
  border: 1px solid var(--border); border-radius: 4px; padding: 3px 10px;
  font: inherit; font-size: 12px; cursor: pointer; }
.gh-banner button:hover { border-color: var(--accent); }
.gh-banner a { color: var(--accent); }
main { display: grid; grid-template-columns: 340px 1fr; gap: 16px;
  padding: 16px 20px; height: calc(100% - 96px); }
@media (max-width: 900px) { main { grid-template-columns: 1fr; } }
.panel { background: var(--panel); border: 1px solid var(--border);
  border-radius: 8px; padding: 12px; display: flex; flex-direction: column; }
.panel h2 { margin: 0 0 10px; font-size: 12px; color: var(--muted);
  text-transform: uppercase; letter-spacing: .05em; }
.card { background: var(--panel2); border: 1px solid var(--border);
  border-radius: 6px; padding: 8px 10px; margin-bottom: 8px; }
.card .row { display: flex; align-items: center; gap: 8px; }
.badge { width: 18px; height: 18px; text-align: center; font-size: 13px;
  flex: none; }
.badge.pending { color: var(--muted); }
.badge.done { color: var(--green); }
.badge.failed { color: var(--red); }
.badge.running { color: var(--accent); }
.spinner { width: 12px; height: 12px; border: 2px solid #333;
  border-top-color: var(--accent); border-radius: 50%;
  animation: rot .8s linear infinite; flex: none; }
@keyframes rot { to { transform: rotate(360deg); } }
.role { font-weight: 600; width: 80px; flex: none; }
.model { color: var(--muted); font-size: 12px; flex: 1; text-align: right;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta-line { color: var(--muted); font-size: 12px; margin-top: 4px; }
.err { color: var(--red); font-size: 12px; margin-top: 4px;
  white-space: pre-wrap; word-break: break-word; }
.empty { color: var(--muted); padding: 20px; text-align: center; font-size: 13px; }
#log { flex: 1; overflow-y: auto; font-size: 12px; min-height: 200px; }
#log .line { display: flex; gap: 8px; padding: 1px 0; white-space: pre-wrap;
  word-break: break-word; border-bottom: 1px solid rgba(255,255,255,.03); }
.line .lrole { width: 72px; flex: none; font-weight: 600; }
.l-analyzer { color: #79c0ff; }
.l-planner { color: #d2a8ff; }
.l-coder { color: #7ee787; }
.l-tester { color: #ffa657; }
.l-reviewer { color: #ffd2a0; }
.l-pr { color: #ff7b72; }
.tabs { display: flex; gap: 0; border-bottom: 1px solid var(--border); margin-bottom: 0; }
.tab-btn { background: var(--panel); color: var(--muted); border: 0;
   border-bottom: 2px solid transparent; padding: 8px 16px; font-size: 12px;
   cursor: pointer; flex: 1; text-align: center; }
.tab-btn:hover { background: var(--panel2); }
.tab-btn.active { color: var(--accent); border-bottom-color: var(--accent); }
.tab-content { display: none; flex: 1; overflow-y: auto; font-size: 12px; min-height: 200px; }
.tab-content.active { display: flex; }
#memory-content, #sessionlog-content { white-space: pre-wrap; word-break: break-word; padding: 12px; }
.activity-item { border-bottom: 1px solid rgba(255,255,255,.03); padding: 4px 0; font-size: 12px; }
.activity-item .a-type { color: var(--muted); font-weight: 600; }
.activity-item .a-text { margin: 2px 0; }
.activity-item .a-tool { color: var(--accent); }
.activity-item .a-result { color: #7ee787; }
.activity-item code { background: var(--panel2); border: 1px solid var(--border);
   padding: 1px 6px; border-radius: 3px; font-size: 11px; }
.tokens { font-size: 11px; color: var(--muted); }
footer { padding: 8px 20px; color: var(--muted); font-size: 11px;
  border-top: 1px solid var(--border); }
</style>
</head>
<body>
<header>
  <h1>Multi-Orchestration</h1>
  <span id="conn" class="conn">connecting…</span>
  <span class="meta" id="meta"></span>
  <span id="gh" class="gh">gh …</span>
</header>
<div id="ghbanner" class="gh-banner" hidden>
  <span class="ghb-title">Not signed in to GitHub</span>
  <button id="ghlogin">Log in</button>
  <button id="ghrecheck">Recheck</button>
  <span class="meta" id="gherr" style="flex-basis:100%"></span>
  <div id="ghcode" hidden>
    <span>Enter this code at</span>
    <a id="ghcodeuri" href="https://github.com/login/device" target="_blank" rel="noopener">github.com/login/device</a>
    <code id="ghuserCode" style="font-size:18px;font-weight:700"></code>
    <button id="ghcodecopy">Copy code</button>
    <span class="meta">…or run <code>gh auth login</code> in a terminal.</span>
  </div>
</div>
<div id="startpanel" class="gh-banner" style="background:rgba(79,195,247,.08);border-bottom-color:var(--accent)">
  <span class="ghb-title" style="color:var(--accent)">Start a repo queue</span>
  <input id="repoinput" type="text" placeholder="owner/name or https://github.com/owner/name" style="flex:1;min-width:220px;background:var(--panel2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:4px 8px;font:inherit">
  <button id="startbtn">Start</button>
  <button id="stopbtn" disabled style="background:var(--panel2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:3px 10px;font:inherit;font-size:12px;cursor:pointer">Stop</button>
  <span id="notice" class="meta" style="flex-basis:100%"></span>
  <span id="scantimer" class="meta" style="flex-basis:100%;color:var(--accent)"></span>
  <span class="meta" style="flex-basis:100%;display:block;margin-top:4px">Provider:
    <button class="provider-btn" data-provider="gemini" style="background:var(--panel2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:3px 10px;font:inherit;font-size:12px;cursor:pointer">Gemini</button>
    <button class="provider-btn" data-provider="openrouter" style="background:var(--panel2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:3px 10px;font:inherit;font-size:12px;cursor:pointer">OpenRouter</button>
    <button class="provider-btn" data-provider="ollama" style="background:var(--panel2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:3px 10px;font:inherit;font-size:12px;cursor:pointer">Ollama</button>
  </span>
</div>
<main>
  <div class="panel">
    <h2>Agents</h2>
    <div id="agents"></div>
  </div>
  <div class="panel">
    <h2>Live transcript</h2>
    <div id="log"><div class="empty">waiting for agent output…</div></div>
  </div>
  </main>
  <div id="modelspanel" class="panel" style="margin-top:16px" hidden>
    <h2>Models</h2>
    <div id="models"><div class="empty">Loading models…</div></div>
    <div id="modelsmsg" class="err" style="margin-top:6px"></div>
  </div>
  <div id="tabs">
  <div class="panel" style="margin-top:16px;">
    <div class="tabs">
      <button class="tab-btn active" onclick="switchTab('transcript', this)">Live transcript</button>
      <button class="tab-btn" onclick="switchTab('memory', this)">MEMORY.md</button>
      <button class="tab-btn" onclick="switchTab('sessionlog', this)">SESSION_LOG.md</button>
      <button class="tab-btn" onclick="switchTab('errorlog', this)">Error Log</button>
    </div>
    <div id="transcript-tab" class="tab-content active">
      <div id="tab-transcript"></div>
    </div>
    <div id="memory-tab" class="tab-content">
      <div id="memory-content" class="empty">Click refresh or wait for a run to populate…</div>
    </div>
    <div id="sessionlog-tab" class="tab-content">
      <div id="sessionlog-content" class="empty">No session started yet.</div>
    </div>
    <div id="errorlog-tab" class="tab-content">
      <div id="errorlog-empty" class="empty" style="padding: 20px; text-align: center;">No model limit errors.</div>
      <div id="errorlog-content" style="overflow-y: auto; height: 300px; padding: 12px;"></div>
    </div>
  </div>
</div>
<footer>EventSource live feed · falls back to 2s polling if the stream drops</footer>
<script>
(function () {
  var ROLES = ["analyzer", "planner", "coder", "tester", "reviewer", "pr"];
  var TERMINAL_PHASES = ["done", "failed", "aborted"];
  var dash = null, log = [], es = null, pollT = null, stick = true;
  var connEl = null, logEl = null, metaEl = null;
  var noticeEl = null, runActive = false;
  var scantimerEl = null, nextScanAt = null;
  function renderScanTimer() {
    if (!scantimerEl) return;
    if (!nextScanAt) { scantimerEl.textContent = ""; return; }
    var ms = nextScanAt - Date.now();
    if (ms <= 0) { scantimerEl.textContent = "⏳ Next scan due…"; return; }
    var totalSec = Math.floor(ms / 1000);
    var m = Math.floor(totalSec / 60), s = totalSec % 60;
    scantimerEl.textContent = "⏳ Next scan in " + m + ":" + (s < 10 ? "0" : "") + s;
  }
  setInterval(renderScanTimer, 1000);
  var stopRequested = false;
  var queueMode = false, modelsLoaded = false;
  var provider = "gemini", providers = ["gemini", "openrouter", "ollama"];
  var agentEvents = {};
  var errorLog = [], logSeeded = false;
  var reconnectT = null, sseRetries = 0, modelsRetryT = null;
  var curTab = "transcript";
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function setConn(live, label) {
    connEl.className = "conn " + (live ? "live" : "dead");
    connEl.textContent = label;
  }
  function renderGh(info) {
    var chip = $("gh"), banner = $("ghbanner"), err = $("gherr"), codeDiv = $("ghcode");
    if (!info) return;
    if (info.ok) {
      chip.textContent = "gh: " + info.username;
      chip.className = "gh ok";
      banner.hidden = true;
      banner.style.display = "none";
      if (err) err.textContent = "";
      if (codeDiv) codeDiv.hidden = true;
    } else {
      chip.textContent = "gh: signed out";
      chip.className = "gh missing";
      banner.hidden = false;
      banner.style.display = "";
      if (err) err.textContent = info.error ? info.error : "Run gh auth login in a terminal, then press Recheck.";
      if (codeDiv) codeDiv.hidden = true;
    }
  }
  function fetchGh() {
    fetch("/api/gh").then(function (r) { return r.json(); })
      .then(function (info) { renderGh(info); })
      .catch(function () { });
  }
  function renderNotice(n) {
    if (!noticeEl) return;
    noticeEl.textContent = n || "";
    var b = $("startbtn"), i = $("repoinput");
    if (b) b.disabled = runActive;
    if (i) i.disabled = runActive;
    if (b) b.textContent = runActive ? "Running…" : "Start";
  }
  function renderStop() {
    var b = $("stopbtn");
    if (!b) return;
    if (runActive || stopRequested) {
      b.textContent = stopRequested ? "Stopping…" : "Stop";
      b.disabled = stopRequested;
    } else {
      b.textContent = "Stop";
      b.disabled = true;
    }
  }
  function requestStop() {
    if (stopRequested) return;
    var resolving = false;
    if (dash && dash.agents) {
      ROLES.forEach(function (r) {
        if (dash.agents[r] && dash.agents[r].state === "running") resolving = true;
      });
    }
    var msg = resolving
      ? "⚠ An issue is currently being resolved. Do you really want to stop now?"
      : "Do you want to stop?";
    if (!confirm(msg)) return;
    stopRequested = true;
    renderStop();
    fetch("/api/stop", { method: "POST", headers: { "Content-Type": "application/json" } })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok) renderNotice((d && d.error) || "stop failed");
      })
      .catch(function () { renderNotice("stop failed — network error"); });
  }
  function renderProvider() {
    var btns = document.querySelectorAll(".provider-btn");
    for (var k = 0; k < btns.length; k++) {
      var active = btns[k].getAttribute("data-provider") === provider;
      btns[k].style.borderColor = active ? "var(--accent)" : "var(--border)";
      btns[k].style.color = active ? "var(--accent)" : "var(--text)";
      btns[k].disabled = runActive;
    }
  }
  function postProvider(p) {
    provider = p;
    renderProvider();
    fetch("/api/provider", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: p })
    }).then(function (r) { return r.json(); })
      .then(function () { fetchModels(); })
      .catch(function () { });
  }
  function copyText(text, btn) {
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch (e) { }
      document.body.removeChild(ta);
    }
    function flash() {
      if (!btn) return;
      var label = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(function () { btn.textContent = label; }, 1500);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(flash, function () { fallback(); flash(); });
    } else {
      fallback();
      flash();
    }
  }
  function startLogin() {
    var banner = $("ghbanner"), err = $("gherr");
    err.textContent = "Starting login…";
    $("ghlogin").disabled = true;
    fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" } })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        $("ghlogin").disabled = false;
        if (!d.ok) {
          err.textContent = d.error || "login failed";
          return;
        }
        if (d.status === "done") {
          err.textContent = "";
          $("ghcode").hidden = true;
          banner.hidden = true;
          $("gh").textContent = "gh: " + (d.username || "signed in");
          $("gh").className = "gh ok";
          return;
        }
        $("ghcode").hidden = false;
        $("ghuserCode").textContent = d.userCode;
        if (d.verificationUri) $("ghcodeuri").href = d.verificationUri;
        err.textContent = "Waiting for you to authorize on the device page…";
      })
      .catch(function () {
        $("ghlogin").disabled = false;
        err.textContent = "login failed — network error";
      });
  }
  function fmtCost(c) { var n = Number(c); return c == null || !isFinite(n) ? "" : "$" + n.toFixed(4); }
  function fmtTokens(t) {
    if (!t) return "";
    var parts = [];
    if (t.input) parts.push("in:" + t.input.toLocaleString());
    if (t.output) parts.push("out:" + t.output.toLocaleString());
    if (t.reasoning) parts.push("r:" + t.reasoning.toLocaleString());
    if (t.cached) parts.push("cached:" + t.cached.toLocaleString());
    if (t.cacheWrite) parts.push("cacheW:" + t.cacheWrite.toLocaleString());
    if (t.total) parts.push("total:" + t.total.toLocaleString());
    return parts.length ? parts.join(" ") + " tok" : "";
  }
   window.switchTab = function(name, btn) {
    curTab = name;
    var tabs = document.querySelectorAll(".tab-btn");
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.remove("active");
    btn.classList.add("active");
    var contents = document.querySelectorAll(".tab-content");
    for (var j = 0; j < contents.length; j++) contents[j].classList.remove("active");
    $("" + name + "-tab").classList.add("active");
    if (name === "memory") fetchMemory();
    if (name === "sessionlog") fetchSessionLog();
    if (name === "errorlog") fetchErrorLog();
  };
  function fetchMemory() {
    var el = $("memory-content");
    if (!el) return;
    el.textContent = "Loading…";
    fetch("/api/memory").then(function (r) { return r.json(); })
      .then(function (d) {
        el.textContent = d.content || "";
      })
      .catch(function () { el.textContent = "Error loading MEMORY.md"; });
  }
function fetchSessionLog() {
    var el = $("sessionlog-content");
    if (!el) return;
    el.textContent = "Loading…";
    fetch("/api/session-log").then(function (r) { return r.json(); })
      .then(function (d) {
        el.textContent = d.content || "";
      })
       .catch(function () { el.textContent = "Error loading SESSION_LOG.md"; });
   }
   function renderErrorLog() {
    var box = $("errorlog-content"), empty = $("errorlog-empty");
    if (!box) return;
    if (empty) empty.hidden = errorLog.length > 0;
    box.innerHTML = "";
    if (!errorLog.length) {
      var none = document.createElement("div");
      none.className = "empty";
      none.style.padding = "20px";
      none.style.textAlign = "center";
      none.textContent = "No model limit errors.";
      box.appendChild(none);
      return;
    }
    errorLog.forEach(function (err) {
      var div = document.createElement("div");
      div.style = "margin-bottom: 8px; padding: 4px; background: var(--panel2); border: 1px solid var(--border); border-radius: 4px;";
      var strong = document.createElement("strong");
      strong.textContent = "[" + (err.type || "error") + "] ";
      div.appendChild(strong);
      var span = document.createElement("span");
      span.textContent = err.message;
      div.appendChild(span);
      if (err.issue !== undefined) {
        var issueSpan = document.createElement("span");
        issueSpan.textContent = " Issue #" + err.issue;
        div.appendChild(issueSpan);
      }
      var timeSpan = document.createElement("span");
      timeSpan.style = "color: var(--muted); font-size: 11px;";
      timeSpan.textContent = " @ " + new Date(err.timestamp).toLocaleTimeString();
      div.appendChild(timeSpan);
      box.appendChild(div);
    });
  }
   function fetchErrorLog() {
    if (curTab !== "errorlog") return;
    if (errorLog.length) { renderErrorLog(); return; }
    fetch("/api/model-limit-error").then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && Array.isArray(d.errorLog)) errorLog = d.errorLog;
        renderErrorLog();
      })
      .catch(function () { renderErrorLog(); });
   }
   function setModelSelectsDisabled(disabled) {
     ROLES.forEach(function (r) {
       var sel = $("model-" + r);
       if (sel) sel.disabled = disabled;
     });
   }
function renderModels(data) {
      var box = $("models");
      if (!box) return;
      var available = data.available || [];
      var models = data.models || {};
      var html = "";
      ROLES.forEach(function (r) {
        var current = models[r] || "";
        var opts = "";
        available.forEach(function (m) {
          var sel = current === m ? " selected" : "";
          opts += '<option value="' + esc(m) + '"' + sel + '>' + esc(m) + '</option>';
        });
        var listId = "models-" + provider;
        html += '<div class="row" style="margin-bottom:8px">' +
          '<span class="role">' + esc(r) + '</span>' +
          '<input list="' + listId + '" id="model-' + r + '" data-role="' + r + '" value="' + esc(current) + '" ' +
          'style="flex:1;background:var(--panel2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:4px 6px;font:inherit">' +
          '<datalist id="' + listId + '">' + opts + '</datalist></div>';
      });
      box.innerHTML = html;
      setModelSelectsDisabled(runActive);
      ROLES.forEach(function (r) {
        var inp = $("model-" + r);
        if (!inp) return;
        inp.addEventListener("change", function () {
          postModel(inp.getAttribute("data-role"), inp.value);
        });
      });
    }
function postModel(role, model) {
      var msg = $("modelsmsg");
      if (msg) msg.textContent = "Saving…";
      fetch("/api/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: role, model: model, provider: provider })
      }).then(function (r) {
        if (r.status === 409) return { ok: false, error: "a run is in progress; cannot change models" };
        return r.json();
      }).then(function (d) {
        fetchModels();
        if (msg) {
          msg.textContent = (d && d.ok) ? "Saved" : ((d && d.error) || "update failed");
          if (d && d.ok) setTimeout(function () { msg.textContent = ""; }, 1500);
        }
      }).catch(function () {
        fetchModels();
        if (msg) msg.textContent = "update failed — network error";
      });
    }
function fetchModels() {
       fetch("/api/models?provider=" + encodeURIComponent(provider)).then(function (r) { return r.json(); })
         .then(function (d) {
           if (modelsRetryT) { clearTimeout(modelsRetryT); modelsRetryT = null; }
           renderModels(d);
         })
         .catch(function () {
           if (modelsRetryT) { clearTimeout(modelsRetryT); modelsRetryT = null; }
           modelsRetryT = setTimeout(fetchModels, 2000);
         });
     }
function syncModelsPanel() {
      var p = $("modelspanel");
      if (!p) return;
      p.hidden = !queueMode;
      if (queueMode && !modelsLoaded) {
        modelsLoaded = true;
        fetchModels();
      }
      setModelSelectsDisabled(runActive);
      renderProvider();
    }
   function syncStartPanel() {
      var sp = $("startpanel");
      if (sp) sp.hidden = !queueMode;
    }
   function renderMeta() {
    if (!dash) {
      metaEl.textContent = "phase not started · waiting for GitHub auth / run start";
      return;
    }
    metaEl.textContent = "run " + dash.runId + " · " + dash.repo + "#" + dash.issue +
      " · phase " + dash.phase + " · loop " + dash.loopIteration;
  }
  function card(a) {
    var icon = a.state === "done" ? "✓" : a.state === "failed" ? "✗" : a.state === "running" ? "" : "·";
    var html = '<div class="card"><div class="row">' +
      '<span class="badge ' + a.state + '">' + icon + '</span>';
    if (a.state === "running") html += '<span class="spinner"></span>';
    html += '<span class="role">' + esc(a.role) + '</span>' +
      '<span class="model">' + esc(String(a.model || "").split("/").pop()) + '</span></div>';
    var meta = [];
    if (a.state === "done" && a.costUsd != null) meta.push(fmtCost(a.costUsd));
    if (a.state === "done" && a.tokens != null) meta.push(fmtTokens(a.tokens));
    if (meta.length) html += '<div class="meta-line">' + esc(meta.join(" · ")) + '</div>';
    if (a.error) html += '<div class="err">' + esc(a.error) + '</div>';
    return html + "</div>";
  }
  function renderAgents() {
    var box = $("agents");
    if (!dash) {
      box.innerHTML = '<div class="empty">Waiting for run to start… (dashboard boots before the GitHub auth check)</div>';
      return;
    }
    var html = "";
    if (dash.prUrl && TERMINAL_PHASES.indexOf(dash.phase) !== -1) {
      html += '<div class="meta-line">Run complete — PR: ' + esc(dash.prUrl) + '</div>';
    }
    ROLES.forEach(function (r) { html += card(dash.agents[r]); });
    box.innerHTML = html;
  }
  function renderLog() {
    if (!log.length) { logEl.innerHTML = '<div class="empty">waiting for agent output…</div>'; return; }
    var html = "";
    log.forEach(function (L) {
      html += '<div class="line"><span class="lrole l-' + L.r + '">' +
        esc(L.r) + "</span><span>" + esc(L.t) + "</span></div>";
    });
    logEl.innerHTML = html;
    if (stick) logEl.scrollTop = logEl.scrollHeight;
    if (curTab === "transcript") renderAgentEvents();
  }
  function pushText(role, text) {
    String(text).split(String.fromCharCode(10)).forEach(function (t) {
      if (t === "") return;
      log.push({ r: role, t: t });
      if (log.length > 200) log.shift();
    });
    renderLog();
  }
  function pushAgentEvent(role, ev) {
    if (!agentEvents[role]) agentEvents[role] = [];
    agentEvents[role].push(ev);
    if (agentEvents[role].length > 100) agentEvents[role].shift();
    if (curTab === "transcript") renderAgentEvents();
  }
  function renderAgentEvents() {
    var box = document.getElementById("tab-transcript");
    if (!box) return;
    var html = "";
    if (!log.length && !hasAgentEvents()) {
      box.innerHTML = '<div class="empty">waiting for agent output…</div>';
      return;
    }
    ROLES.forEach(function (r) {
      var events = agentEvents[r] || [];
      if (!events.length) return;
      html += '<div style="margin-bottom:12px"><div class="lrole l-' + r + '">' + esc(r) + '</div>';
      events.forEach(function (ev) {
        html += formatAgentEvent(ev);
      });
      html += "</div>";
    });
    box.innerHTML = html;
    if (stick) box.scrollTop = box.scrollHeight;
  }
  function hasAgentEvents() {
    for (var i = 0; i < ROLES.length; i++) {
      if (agentEvents[ROLES[i]] && agentEvents[ROLES[i]].length > 0) return true;
    }
    return false;
  }
  function formatAgentEvent(ev) {
    var t = ev.t || ev.type || "unknown";
    var part = ev.part || {};
    if (t === "step_start") return "";
    var html = '<div class="activity-item"><span class="a-type">' + esc(t) + '</span>';
    if (t === "init") {
      var parts = [];
      if (ev.role) parts.push("role: " + esc(ev.role));
      if (ev.model) parts.push("model: " + esc(ev.model));
      if (ev.provider) parts.push("provider: " + esc(ev.provider));
      if (ev.sessionId) parts.push("session: " + esc(ev.sessionId));
      if (parts.length) html += '<div class="a-text">' + esc(parts.join(" · ")) + '</div>';
    } else if (t === "text" && typeof part.text === "string") {
      html += '<div class="a-text">' + esc(part.text.slice(0, 500)) + '</div>';
    } else if (t === "tool_call") {
      var name = "⚙ " + (ev.name || "");
      html += ' <span class="a-tool">' + esc(name) + '</span>';
      if (ev.input) {
        var preview = ev.input.command || ev.input.filePath || ev.input.pattern || ev.input.url || ev.input.query || "";
        if (!preview && Object.keys(ev.input).length) {
          try { preview = JSON.stringify(ev.input); } catch (_) { preview = ""; }
        }
        if (preview) html += '<div class="a-text">' + esc(preview.slice(0, 120)) + '</div>';
      }
    } else if (t === "tool_result") {
      var name = "⚙ " + (ev.name || "");
      var ok = ev.ok ? "✓" : "✗";
      html += ' <span class="a-tool">' + esc(name) + '</span>';
      html += ' <span class="a-result">' + ok + '</span>';
      if (ev.ms !== undefined) html += ' <span class="a-result">' + ev.ms + 'ms</span>';
      if (ev.bytesOut !== undefined) html += ' <span class="a-result">' + ev.bytesOut + 'B</span>';
    } else if (t === "step_finish") {
      var usage = ev.usage || ev.tokens || (part.tokens ? part.tokens : {});
      var cost = typeof ev.costUsd === "number" ? ev.costUsd : (typeof part.cost === "number" ? part.cost : 0);
      var summary = "";
      if (usage.input) summary += "in " + usage.input;
      if (usage.output) summary += (summary ? " · " : "") + "out " + usage.output;
      if (usage.reasoning) summary += (summary ? " · " : "") + "reasoning " + usage.reasoning;
      if (usage.cached) summary += (summary ? " · " : "") + "cached " + usage.cached;
      if (cost) summary += (summary ? " · " : "") + "$" + cost.toFixed(6);
      if (summary) html += ' <span class="a-result">·</span> ' + esc(summary);
    } else if (t === "error") {
      var errMsg = ev.error || ev.message || "unknown error";
      html += '<div class="a-text" style="color:var(--red)">' + esc(String(errMsg).slice(0, 500)) + '</div>';
    } else if (t === "result" && typeof ev.text === "string") {
      html += '<div class="a-text">' + esc(ev.text.slice(0, 500)) + '</div>';
    } else if (t === "tool_use" || part.type === "tool") {
      var name = "⚙ " + (part.tool || "");
      html += ' <span class="a-tool">' + esc(name) + '</span>';
      var status = part.state && part.state.status === "completed" ? "✓" : "✗";
      html += ' <span class="a-result">' + status + '</span>';
      var input = part.state && part.state.input || {};
      var preview = input.command || input.filePath || input.pattern || input.url || input.query || "";
      if (!preview && Object.keys(input).length) {
        try { preview = JSON.stringify(input); } catch (_) { preview = ""; }
      }
      if (preview) html += '<div class="a-text">' + esc(preview.slice(0, 120)) + '</div>';
      if (status === "✗" && part.state && part.state.output) {
        html += '<div class="a-text">' + esc(String(part.state.output).slice(0, 200)) + '</div>';
      }
    } else {
      html += '<code>' + esc(JSON.stringify(ev).slice(0, 120)) + '</code>';
    }
    html += '</div>';
    return html;
  }
  function applyState(s) {
    if (s.dash) { dash = s.dash; renderMeta(); renderAgents(); }
    if (s.gh) renderGh(s.gh);
    if (s.agentEvents) {
      agentEvents = s.agentEvents;
      if (curTab === "transcript") renderAgentEvents();
    }
    if (s.outputs && !logSeeded) {
      log = [];
      ROLES.forEach(function (r) {
        (s.outputs[r] || []).forEach(function (chunk) {
          String(chunk).split(String.fromCharCode(10)).forEach(function (t) {
            if (t === "") return;
            log.push({ r: r, t: t });
            if (log.length > 200) log.shift();
          });
        });
      });
      logSeeded = true;
      renderLog();
    }
    if (Array.isArray(s.errorLog)) {
      errorLog = s.errorLog;
      if (curTab === "errorlog") renderErrorLog();
    }
    if (typeof s.runActive === "boolean") runActive = s.runActive;
    if (typeof s.queueMode === "boolean") queueMode = s.queueMode;
    if (typeof s.stopRequested === "boolean") stopRequested = s.stopRequested;
    if (s.provider && providers.indexOf(s.provider) !== -1) {
      var prev = provider;
      provider = s.provider;
      if (prev !== provider && modelsLoaded) fetchModels();
    }
    if (typeof s.notice !== "undefined") renderNotice(s.notice);
    if (typeof s.nextScanAt !== "undefined") { nextScanAt = s.nextScanAt; renderScanTimer(); }
    renderStop();
    syncModelsPanel();
    syncStartPanel();
  }
  function resync() {
    fetch("/api/state").then(function (r) { return r.json(); })
      .then(function (s) { applyState(s); })
      .catch(function () { });
  }
  function startQueue() {
    if (runActive) return;
    var value = $("repoinput").value;
    if (!value.trim()) {
      renderNotice("Enter a repo (owner/name or https://github.com/owner/name)");
      return;
    }
    runActive = true;
    stopRequested = false;
    renderStop();
    renderNotice("Starting…");
    fetch("/api/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: value, provider: provider })
    }).then(function (r) {
      if (r.status >= 400) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          return { ok: false, error: (d && d.error) || "start rejected (" + r.status + ")" };
        });
      }
      return r.json();
    }).then(function (d) {
      if (d && d.ok) {
        renderNotice("Queue started…");
      } else {
        runActive = false;
        stopRequested = false;
        renderStop();
        renderNotice((d && d.error) || "start failed");
        resync();
      }
    })
      .catch(function () {
        runActive = false;
        stopRequested = false;
        renderStop();
        renderNotice("start failed — network error");
      });
  }
  function stopPoll() { if (pollT) { clearInterval(pollT); pollT = null; } }
  function startPoll() {
    stopPoll();
    if (reconnectT) { clearTimeout(reconnectT); reconnectT = null; }
    setConn(false, "reconnecting (polling)");
    logSeeded = false;
    pollT = setInterval(function () {
      fetch("/api/state").then(function (r) { return r.json(); })
        .then(function (s) { applyState(s); })
        .catch(function () { });
    }, 2000);
  }
  function parseEv(e) {
    try { return JSON.parse(e.data); } catch (err) { return null; }
  }
  function startSSE() {
    if (es) { es.close(); es = null; }
    es = new EventSource("/api/events");
    es.addEventListener("snapshot", function (e) {
      var d = parseEv(e);
      if (d) { logSeeded = false; applyState(d); }
    });
    es.addEventListener("state", function (e) {
      var d = parseEv(e);
      if (d) applyState(d);
    });
    es.addEventListener("gh", function (e) {
      var d = parseEv(e);
      if (d) renderGh(d);
    });
    es.addEventListener("models", function (e) {
      var d = parseEv(e);
      if (!d) return;
      if (modelsRetryT) { clearTimeout(modelsRetryT); modelsRetryT = null; }
      modelsLoaded = true;
      if (d.provider && providers.indexOf(d.provider) !== -1) provider = d.provider;
      renderModels(d);
      renderProvider();
    });
    es.addEventListener("provider", function (e) {
      var d = parseEv(e);
      if (d && d.provider && providers.indexOf(d.provider) !== -1) {
        var prev = provider;
        provider = d.provider;
        renderProvider();
        if (prev !== provider && modelsLoaded) fetchModels();
      }
    });
    es.addEventListener("output", function (e) {
      var d = parseEv(e);
      if (d) pushText(d.role, d.text);
    });
    es.addEventListener("agent-event", function (e) {
      var d = parseEv(e);
      if (d) pushAgentEvent(d.role, d.event);
    });
    es.onopen = function () {
      setConn(true, "live");
      stopPoll();
      sseRetries = 0;
    };
    es.onerror = function () {
      setConn(false, "reconnecting…");
      if (es) { es.close(); es = null; }
      if (reconnectT) { clearTimeout(reconnectT); reconnectT = null; }
      if (sseRetries >= 5) { startPoll(); return; }
      sseRetries += 1;
      reconnectT = setTimeout(startSSE, 2000);
    };
  }
  function onLoad() {
    connEl = $("conn"); logEl = $("log"); metaEl = $("meta"); noticeEl = $("notice"); scantimerEl = $("scantimer");
    renderMeta();
    renderStop();
    syncStartPanel();
    $("ghrecheck").addEventListener("click", fetchGh);
    $("ghlogin").addEventListener("click", startLogin);
    $("ghcodecopy").addEventListener("click", function () {
      copyText($("ghuserCode").textContent, $("ghcodecopy"));
    });
    $("startbtn").addEventListener("click", startQueue);
    $("stopbtn").addEventListener("click", requestStop);
    $("repoinput").addEventListener("keydown", function (e) {
      if (e.key === "Enter") startQueue();
    });
    var providerBtns = document.querySelectorAll(".provider-btn");
    for (var pi = 0; pi < providerBtns.length; pi++) {
      providerBtns[pi].addEventListener("click", function () {
        if (runActive) return;
        postProvider(this.getAttribute("data-provider"));
      });
    }
    renderProvider();
    fetchGh();
    setInterval(fetchGh, 5000);
    logEl.addEventListener("scroll", function () {
      stick = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 40;
    });
    var tabTrans = document.getElementById("tab-transcript");
    if (tabTrans) {
      tabTrans.addEventListener("scroll", function () {
        stick = tabTrans.scrollTop + tabTrans.clientHeight >= tabTrans.scrollHeight - 40;
      });
    }
    setInterval(function () {
      if (curTab === "memory") fetchMemory();
      if (curTab === "sessionlog") fetchSessionLog();
    }, 5000);
    fetch("/api/state").then(function (r) { return r.json(); })
      .then(function (s) { applyState(s); startSSE(); })
      .catch(function () { startPoll(); });
  }
  document.addEventListener("DOMContentLoaded", onLoad);
})();
</script>
</body>
</html>`;

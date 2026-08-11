// Live local web dashboard — zero runtime deps, Node built-ins only.
// Serves a self-contained HTML page (no CDN, no build step), JSON state,
// and a Server-Sent Events feed. Strictly a read-only mirror of the terminal TUI.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DashboardState } from "../tui/dashboard.js";
import type { Backend, Role } from "../types.js";
import { ghAuthInfo, type GhAuthInfo } from "../github/gh.js";
import { startDeviceLogin, pollDeviceToken, storeGhToken } from "../github/gh.js";
import {
  availableModels,
  BACKENDS,
  getModelOverrides,
  setModelOverride,
  saveModelOverrides,
} from "../models/modelPolicy.js";

const DEFAULT_PORT = 3456;
const HOST = "127.0.0.1";
const MAX_CHUNKS = 200;
const MAX_BYTES = 30 * 1024;
const HEARTBEAT_MS = 25_000;

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
  private onStartRequest: ((repo: string, backend: Backend) => Promise<{ ok: boolean; error?: string; runStarted?: boolean }>) | null = null;
  private runActive = false;
  private notice: string | null = null;
  private loginInProgress = false;
  private backend: Backend = "opencode";
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
    onStartRequest?: (repo: string, backend: Backend) => Promise<{ ok: boolean; error?: string; runStarted?: boolean }>,
    initialBackend: Backend = "opencode",
  ) {
    this.port = port;
    this.rootDir = rootDir;
    this.onStartRequest = onStartRequest ?? null;
    this.backend = initialBackend;
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
    runActive: boolean;
    queueMode: boolean;
    backend: Backend;
  } {
    return { dash: this.dash, outputs: this.outputs, agentEvents: this.agentEvents, gh: this.gh, notice: this.notice, runActive: this.runActive, queueMode: this.onStartRequest !== null, backend: this.backend };
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    if (req.method === "POST" && new URL(req.url ?? "/", `http://${HOST}`).pathname === "/api/start") {
      this.handleStart(req, res);
      return;
    }
    if (req.method === "POST" && new URL(req.url ?? "/", `http://${HOST}`).pathname === "/api/login") {
      this.handleLogin(res);
      return;
    }
    if (req.method === "POST" && new URL(req.url ?? "/", `http://${HOST}`).pathname === "/api/models") {
      this.handleModels(req, res);
      return;
    }
    if (req.method === "POST" && new URL(req.url ?? "/", `http://${HOST}`).pathname === "/api/backend") {
      this.handleBackend(req, res);
      return;
    }
    if ((req.method ?? "GET") !== "GET") {
      this.sendJson(res, 404, { error: "not found" });
      return;
    }
    const path = new URL(req.url ?? "/", `http://${HOST}`).pathname;
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
      const url = new URL(req.url ?? "/", `http://${HOST}`);
      const backend = url.searchParams.get("backend") as Backend | null;
      const b = backend && (BACKENDS as readonly string[]).includes(backend) ? backend : this.backend;
      this.sendJson(res, 200, { models: getModelOverrides()[b] ?? {}, available: [...availableModels(b)] });
      return;
    }
    if (path === "/api/backend") {
      this.sendJson(res, 200, { backend: this.backend, backends: [...BACKENDS] });
      return;
    }
    if (path === "/api/events") {
      this.openSse(req, res);
      return;
    }
    if (path === "/api/memory") {
      void this.sendFile(res, join(this.rootDir, "MEMORY.md"));
      return;
    }
    if (path === "/api/session-log") {
      void this.sendFile(res, join(this.rootDir, "SESSION_LOG.md"));
      return;
    }
    this.sendJson(res, 404, { error: "not found" });
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
      const rawBackend = (body as { backend?: unknown }).backend;
      const backend =
        typeof rawBackend === "string" && (BACKENDS as readonly string[]).includes(rawBackend)
          ? (rawBackend as Backend)
          : this.backend;
      if (this.runActive) {
        this.sendJson(res, 200, { ok: false, error: "a run is already in progress" });
        return;
      }
      this.runActive = true;
      if (!this.onStartRequest) {
        this.runActive = false;
        this.sendJson(res, 200, { ok: false, error: "no start handler registered" });
        return;
      }
      void this.onStartRequest(repo, backend)
        .then((result) => {
          this.sendJson(res, 200, result);
          if (!result.ok || !result.runStarted) this.runActive = false;
        })
        .catch((err) => {
          this.runActive = false;
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
      const rawBackend = (body as { backend?: unknown }).backend;
      const backend =
        typeof rawBackend === "string" && (BACKENDS as readonly string[]).includes(rawBackend)
          ? (rawBackend as Backend)
          : this.backend;
      if (typeof role !== "string" || !ROLES.includes(role as Role)) {
        this.sendJson(res, 400, { ok: false, error: "invalid role" });
        return;
      }
      if (typeof model !== "string" || !availableModels(backend).includes(model)) {
        this.sendJson(res, 400, { ok: false, error: "invalid model" });
        return;
      }
      if (this.runActive) {
        this.sendJson(res, 409, { ok: false, error: "a run is in progress; cannot change models" });
        return;
      }
      try {
        setModelOverride(role as Role, model, backend);
      } catch (err) {
        this.sendJson(res, 400, { ok: false, error: String(err instanceof Error ? err.message : err) });
        return;
      }
      saveModelOverrides(join(this.rootDir, "models.json"));
      this.sendJson(res, 200, { ok: true, models: getModelOverrides()[backend] ?? {} });
    });
    req.on("error", () => {
      if (!done) {
        done = true;
        this.sendJson(res, 400, { ok: false, error: "request error" });
      }
    });
  }

  /** Set the run backend (opencode | claude | codex) used for the next queue start. */
  private handleBackend(req: IncomingMessage, res: ServerResponse): void {
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
      const backend = (body as { backend?: unknown }).backend;
      if (typeof backend !== "string" || !(BACKENDS as readonly string[]).includes(backend)) {
        this.sendJson(res, 400, { ok: false, error: `invalid backend; must be one of: ${BACKENDS.join(", ")}` });
        return;
      }
      this.backend = backend as Backend;
      this.lastEventId += 1;
      this.broadcast(this.lastEventId, "backend", { backend: this.backend, backends: [...BACKENDS] });
      this.sendJson(res, 200, { ok: true, backend: this.backend });
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
  <span id="notice" class="meta" style="flex-basis:100%"></span>
  <span class="meta" style="flex-basis:100%;display:block;margin-top:4px">Backend:
    <button class="backend-btn" data-backend="opencode" style="background:var(--panel2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:3px 10px;font:inherit;font-size:12px;cursor:pointer">OpenCode</button>
    <button class="backend-btn" data-backend="claude" style="background:var(--panel2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:3px 10px;font:inherit;font-size:12px;cursor:pointer">Claude</button>
    <button class="backend-btn" data-backend="codex" style="background:var(--panel2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:3px 10px;font:inherit;font-size:12px;cursor:pointer">Codex</button>
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
  var queueMode = false, modelsLoaded = false;
  var backend = "opencode", backends = ["opencode", "claude", "codex"];
  var agentEvents = {};
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
  function renderBackend() {
    var btns = document.querySelectorAll(".backend-btn");
    for (var k = 0; k < btns.length; k++) {
      var active = btns[k].getAttribute("data-backend") === backend;
      btns[k].style.borderColor = active ? "var(--accent)" : "var(--border)";
      btns[k].style.color = active ? "var(--accent)" : "var(--text)";
      btns[k].disabled = runActive;
    }
  }
  function postBackend(b) {
    backend = b;
    renderBackend();
    fetch("/api/backend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backend: b })
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
    fetch("/api/login", { method: "POST" })
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
  function fmtCost(c) { return c == null ? "" : "$" + c.toFixed(4); }
  function fmtTokens(t) {
    if (!t) return "";
    var parts = [];
    if (t.input) parts.push("in:" + t.input.toLocaleString());
    if (t.output) parts.push("out:" + t.output.toLocaleString());
    if (t.reasoning) parts.push("r:" + t.reasoning.toLocaleString());
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
       var listId = "models-" + backend;
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
       body: JSON.stringify({ role: role, model: model, backend: backend })
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
     fetch("/api/models?backend=" + encodeURIComponent(backend)).then(function (r) { return r.json(); })
       .then(function (d) { renderModels(d); })
       .catch(function () { });
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
     renderBackend();
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
    if (log.length) {
      html += '<hr style="border-color:var(--border)">';
      log.forEach(function (L) {
        html += '<div class="line"><span class="lrole l-' + L.r + '">' +
          esc(L.r) + "</span><span>" + esc(L.t) + "</span></div>";
      });
    }
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
    var type = ev.type || "unknown";
    var part = ev.part || {};
    var html = '<div class="activity-item"><span class="a-type">' + esc(type) + '</span>';
    if (type === "text" && typeof part.text === "string") {
      html += '<div class="a-text">' + esc(part.text.slice(0, 500)) + '</div>';
    } else if (type === "tool_call" || (part && part.type === "tool_call")) {
      var name = part.name || part.toolName || "";
      html += ' <span class="a-tool">' + esc(name) + '</span>';
      if (part.input) html += '<div class="a-text">' + esc(JSON.stringify(part.input).slice(0, 300)) + '</div>';
    } else if (type === "tool_result" || part.type === "tool_result") {
      var success = part.success !== false;
      html += ' <span class="a-result">' + (success ? "✓" : "✗") + '</span>';
      if (part.output) html += '<div class="a-text">' + esc(String(part.output).slice(0, 300)) + '</div>';
    } else if (type === "step_finish" || type === "step_start") {
      html += '<div class="a-text">' + esc(JSON.stringify(part).slice(0, 300)) + '</div>';
    } else {
      html += '<code>' + esc(JSON.stringify(part).slice(0, 200)) + '</code>';
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
    if (s.outputs) {
      log = [];
      ROLES.forEach(function (r) {
        (s.outputs[r] || []).forEach(function (chunk) {
          pushText(r, chunk);
        });
      });
      renderLog();
    }
    if (typeof s.runActive === "boolean") runActive = s.runActive;
    if (typeof s.queueMode === "boolean") queueMode = s.queueMode;
    if (s.backend && backends.indexOf(s.backend) !== -1) {
      var prev = backend;
      backend = s.backend;
      if (prev !== backend && modelsLoaded) fetchModels();
    }
    if (typeof s.notice !== "undefined") renderNotice(s.notice);
    syncModelsPanel();
  }
  function startQueue() {
    if (runActive) return;
    var value = $("repoinput").value;
    if (!value.trim()) {
      renderNotice("Enter a repo (owner/name or https://github.com/owner/name)");
      return;
    }
    runActive = true;
    renderNotice("Starting…");
    fetch("/api/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: value, backend: backend })
    }).then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.ok) {
          renderNotice("Queue started…");
        } else {
          runActive = false;
          renderNotice((d && d.error) || "start failed");
        }
      })
      .catch(function () {
        runActive = false;
        renderNotice("start failed — network error");
      });
  }
  function stopPoll() { if (pollT) { clearInterval(pollT); pollT = null; } }
  function startPoll() {
    stopPoll();
    setConn(false, "reconnecting (polling)");
    pollT = setInterval(function () {
      fetch("/api/state").then(function (r) { return r.json(); })
        .then(function (s) { applyState(s); })
        .catch(function () { });
    }, 2000);
  }
  function startSSE() {
    if (es) { es.close(); es = null; }
    es = new EventSource("/api/events");
    es.addEventListener("snapshot", function (e) { applyState(JSON.parse(e.data)); });
    es.addEventListener("state", function (e) { applyState(JSON.parse(e.data)); });
    es.addEventListener("gh", function (e) { renderGh(JSON.parse(e.data)); });
    es.addEventListener("backend", function (e) {
      var d = JSON.parse(e.data);
      if (d.backend && backends.indexOf(d.backend) !== -1) {
        var prev = backend;
        backend = d.backend;
        renderBackend();
        if (prev !== backend && modelsLoaded) fetchModels();
      }
    });
    es.addEventListener("output", function (e) {
      var d = JSON.parse(e.data);
      pushText(d.role, d.text);
    });
    es.addEventListener("agent-event", function (e) {
      var d = JSON.parse(e.data);
      pushAgentEvent(d.role, d.event);
    });
    es.onopen = function () { setConn(true, "live"); };
    es.onerror = function () {
      setConn(false, "reconnecting…");
      if (es) { es.close(); es = null; }
      startPoll();
    };
  }
  function onLoad() {
    connEl = $("conn"); logEl = $("log"); metaEl = $("meta"); noticeEl = $("notice");
    renderMeta();
    $("ghrecheck").addEventListener("click", fetchGh);
    $("ghlogin").addEventListener("click", startLogin);
    $("ghcodecopy").addEventListener("click", function () {
      copyText($("ghuserCode").textContent, $("ghcodecopy"));
    });
    $("startbtn").addEventListener("click", startQueue);
    $("repoinput").addEventListener("keydown", function (e) {
      if (e.key === "Enter") startQueue();
    });
    var backendBtns = document.querySelectorAll(".backend-btn");
    for (var bi = 0; bi < backendBtns.length; bi++) {
      backendBtns[bi].addEventListener("click", function () {
        if (runActive) return;
        postBackend(this.getAttribute("data-backend"));
      });
    }
    renderBackend();
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

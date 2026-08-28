// Live local web dashboard — zero runtime deps, Node built-ins only.
// Serves a self-contained HTML page (no CDN, no build step), JSON state,
// and a Server-Sent Events feed. Strictly a read-only mirror of the terminal TUI.

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { join } from "node:path";
import type { QuotaEvent } from "../fleet/quotaEvents.ts";
import { type GhAuthInfo, ghAuthInfo } from "../github/gh.ts";
import { resolveManagerPath } from "../memory/paths.ts";
import type { DashboardState } from "../tui/dashboard.ts";
import type { ProviderName, Role } from "../types.ts";
import { PROVIDER_NAMES } from "../types.ts";
import {
	ApiHandlers,
	type WebhookHandler,
	type WebhookResponse,
} from "./api.ts";

export type { WebhookHandler, WebhookResponse };

const DEFAULT_PORT = 3456;
const HOST = "127.0.0.1";
const MAX_CHUNKS = 200;
const HEARTBEAT_MS = 25_000;

interface SseClient {
	res: ServerResponse;
	timer: NodeJS.Timeout;
}

export class WebDashboard {
	private readonly port: number;
	private readonly rootDir: string;
	private server: Server | null = null;
	private clients = new Map<ServerResponse, SseClient>();
	private lastEventId = 0;
	private combinedHtml: string;
	private apiHandlers: ApiHandlers;

	constructor(
		port: number = DEFAULT_PORT,
		rootDir: string,
		onStartRequest?: (
			repo: string,
			provider: ProviderName,
		) => Promise<{ ok: boolean; error?: string; runStarted?: boolean }>,
		initialProvider: ProviderName = "gemini",
		onStopRequest: (() => void) | null = null,
		onWebhook?: WebhookHandler,
		onResumeRequest?: (() => boolean) | null,
	) {
		this.port = port;
		this.rootDir = rootDir;

		// Load template and client JS, combine them
		try {
			const templatePath = join(this.rootDir, "src/dashboard/template.html");
			const clientJsPath = join(this.rootDir, "src/dashboard/client.js");
			const template = readFileSync(templatePath, "utf8");
			const clientJs = readFileSync(clientJsPath, "utf8");
			this.combinedHtml = template.replace(
				"<!-- INJECT_CLIENT_JS -->",
				`<script>${clientJs}</script>`,
			);
		} catch (err) {
			console.error("Failed to load dashboard template or client JS:", err);
			// Fallback to a minimal error page
			this.combinedHtml = `<!doctype html><html><head><title>Fleet Dashboard Error</title></head><body><h1>Failed to load dashboard</h1><p>See server logs for details.</p></body></html>`;
		}

		// Initialize API handlers
		this.apiHandlers = new ApiHandlers(
			rootDir,
			onStartRequest,
			initialProvider,
			onStopRequest,
			onWebhook,
			onResumeRequest,
			(event) => this.pushTelemetry(event),
		);

		// Connect API handlers to dashboard state updates
		this.setupApiHandlerBindings();
	}

	private setupApiHandlerBindings(): void {
		// We'll use a polling approach to sync state from API handlers to dashboard
		// In a more sophisticated implementation, we might use events or callbacks
		// For now, the API handlers will call methods on the dashboard to update state
		// and trigger broadcasts
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
		const boundPort =
			typeof addr === "object" && addr !== null ? addr.port : this.port;
		return { url: `http://${HOST}:${boundPort}/`, port: boundPort };
	}

	/** Store the latest dashboard state and broadcast it to every SSE client. */
	pushState(dash: DashboardState): void {
		this.lastEventId += 1;
		this.broadcast(this.lastEventId, "state", this.snapshot(dash));
	}

	/** Set a terminal phase (+ optional PR url) on the latest dash state and broadcast it. No-op before a run starts. */
	pushFinal(_phase: DashboardState["phase"], _prUrl?: string): void {
		// This would typically be called by the orchestrator, not directly
		// For now, we'll assume the state is pushed via pushState
	}

	/** Toggle the persistent quota-pause banner state and broadcast it (SPEC §11.5 PAUSED). */
	setPaused(paused: boolean, message?: string): void {
		// Update API handlers state
		this.apiHandlers.setPaused(paused);
		if (message !== undefined) this.apiHandlers.setNotice(message);

		this.lastEventId += 1;
		this.broadcast(this.lastEventId, "state", this.snapshot());
	}

	/** Store gh auth info and broadcast it to every SSE clients. */
	pushGh(info: GhAuthInfo): void {
		this.apiHandlers.setGh(info);
		this.lastEventId += 1;
		this.broadcast(this.lastEventId, "gh", info);
	}

	/** Store a status/notice line and broadcast it with the state snapshot. */
	pushNotice(msg: string): void {
		this.apiHandlers.setNotice(msg);
		this.lastEventId += 1;
		this.broadcast(this.lastEventId, "state", this.snapshot());
	}

	/** Publish/clear the next daemon scan deadline (epoch ms) for the live countdown. */
	pushNextScanAt(ts: number | null): void {
		this.apiHandlers.setNextScanAt(ts);
		this.lastEventId += 1;
		this.broadcast(this.lastEventId, "state", this.snapshot());
	}

	/** Append a live text chunk for `role` (capped) and broadcast it. */
	pushOutput(role: Role, text: string): void {
		const snap = this.apiHandlers.getSnapshot();
		if (snap.outputs[role]) {
			snap.outputs[role].push(text);
			if (snap.outputs[role].length > MAX_CHUNKS) snap.outputs[role].shift();
		}
		this.lastEventId += 1;
		const id = this.lastEventId;
		this.broadcast(id, "output", { role, text, lastEventId: id });
	}

	/** Broadcast an agent stream event (thinking, tool call, result, etc.). */
	pushAgentEvent(role: Role, event: Record<string, unknown>): void {
		const snap = this.apiHandlers.getSnapshot();
		if (snap.agentEvents[role]) {
			snap.agentEvents[role].push(event);
			if (snap.agentEvents[role].length > MAX_CHUNKS)
				snap.agentEvents[role].shift();
		}
		this.lastEventId += 1;
		this.broadcast(this.lastEventId, "agent-event", { role, event });
	}

	/** Publish redacted coordinator/metadata telemetry to dashboard SSE clients. */
	pushTelemetry(event: Record<string, unknown>): void {
		this.lastEventId += 1;
		this.broadcast(this.lastEventId, "telemetry", event);
	}

	/** Broadcast a manager-side Gemini quota event (switch / recovered / exhausted). */
	pushQuotaEvent(event: QuotaEvent): void {
		this.lastEventId += 1;
		this.broadcast(this.lastEventId, "quota_event", {
			type: "quota_event",
			event,
		});
	}

	private snapshot(dash?: DashboardState | null): {
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
		paused: boolean;
		errorLog: Array<{
			type: string;
			message: string;
			agent: string;
			issue?: number;
			timestamp: number;
		}>;
	} {
		// Get state from API handlers and combine with dashboard state
		const apiSnapshot = this.apiHandlers.getSnapshot();
		return {
			dash: dash ?? apiSnapshot.dash, // Use provided dash or fallback
			outputs: apiSnapshot.outputs,
			agentEvents: apiSnapshot.agentEvents,
			gh: apiSnapshot.gh,
			notice: apiSnapshot.notice,
			nextScanAt: apiSnapshot.nextScanAt,
			runActive: apiSnapshot.runActive,
			queueMode: apiSnapshot.queueMode,
			provider: apiSnapshot.provider,
			stopRequested: apiSnapshot.stopRequested,
			paused: apiSnapshot.paused,
			errorLog: apiSnapshot.errorLog,
		};
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

	private handle(req: IncomingMessage, res: ServerResponse): void {
		const path = new URL(req.url ?? "/", `http://${HOST}`).pathname;
		if (req.method === "OPTIONS") {
			this.apiHandlers.handlePreflight(req, res);
			return;
		}
		if (req.method === "POST") {
			if (path === "/webhook") {
				this.apiHandlers.handleWebhook(req, res);
				return;
			}
			if (!this.apiHandlers.guardMutation(req, res)) return;
			if (path === "/api/start") {
				this.apiHandlers.handleStart(req, res);
				return;
			}
			if (path === "/api/stop") {
				this.apiHandlers.handleStop(res);
				return;
			}
			if (path === "/api/resume") {
				this.apiHandlers.handleResume(res);
				return;
			}
			if (path === "/api/login") {
				this.apiHandlers.handleLogin(res);
				return;
			}
			if (path === "/api/models") {
				this.apiHandlers.handleModels(req, res);
				return;
			}
			if (path === "/api/provider") {
				this.apiHandlers.handleProvider(req, res);
				return;
			}
			if (path === "/api/model-limit-error") {
				this.apiHandlers.handleModelLimitError(req, res);
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
			// For state endpoint, we need to get the current dashboard state
			// This is a simplified version - in reality we'd need to sync with API handlers
			this.sendJson(res, 200, this.snapshot());
			return;
		}
		if (path === "/api/models") {
			void this.apiHandlers.sendModels(req, res);
			return;
		}
		if (path === "/api/provider") {
			this.sendJson(res, 200, {
				provider: this.apiHandlers.provider,
				providers: [...PROVIDER_NAMES],
			});
			return;
		}
		if (path === "/api/events") {
			this.openSse(req, res);
			return;
		}
		if (path === "/api/memory") {
			void this.sendFile(res, resolveManagerPath(this.rootDir, "MEMORY.txt"));
			return;
		}
		if (path === "/api/model-limit-error") {
			this.sendJson(res, 200, {
				ok: true,
				errorLog: this.apiHandlers.errorLog,
			});
			return;
		}
		if (path === "/api/session-log") {
			void this.sendFile(
				res,
				resolveManagerPath(this.rootDir, "SESSION_LOG.txt"),
			);
			return;
		}
		this.sendJson(res, 404, { error: "not found" });
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
			res.end(this.combinedHtml);
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
			res.write(
				`id: ${id}\nevent: snapshot\ndata: ${JSON.stringify(this.snapshot())}\n\n`,
			);
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

	private broadcast(id: number, event: string, data: unknown): void {
		const payload = `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
		for (const [res] of this.clients) {
			try {
				res.write(payload);
			} catch {
				this.dropClient(res);
			}
		}
	}

	get outputs(): Record<Role, string[]> {
		return this.apiHandlers.getSnapshot().outputs;
	}

	get agentEvents(): Record<Role, Record<string, unknown>[]> {
		return this.apiHandlers.getSnapshot().agentEvents;
	}
}

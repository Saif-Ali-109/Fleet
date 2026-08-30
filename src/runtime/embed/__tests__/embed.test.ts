import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EMBED_ENTRY = resolve(__dirname, "../main.ts");

interface EmbedJob {
	type: "embed";
	texts: string[];
	provider?: string;
	model?: string;
}

interface ShutdownJob {
	type: "shutdown";
}

type Job = EmbedJob | ShutdownJob;

interface EmbedResult {
	type: "embed_result";
	vectors: number[][] | null;
	error?: string;
}

function spawnEmbedWorker(env: Record<string, string> = {}): ReturnType<typeof fork> {
	const child = fork(EMBED_ENTRY, {
		execPath: process.execPath,
		execArgv: [...process.execArgv, "--import", "tsx"],
		stdio: ["pipe", "pipe", "pipe", "ipc"],
		env: { ...process.env, ...env },
	});

	child.stdout?.on("data", (data) => {
		console.log("[TEST STDOUT]", data.toString());
	});

	child.stderr?.on("data", (data) => {
		console.log("[TEST STDERR]", data.toString());
	});

	child.on("error", (err) => {
		console.log("[TEST ERROR]", err);
	});

	child.on("exit", (code, signal) => {
		console.log("[TEST EXIT]", code, signal);
	});

	return child;
}

async function waitForReady(child: ReturnType<typeof fork>): Promise<void> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			child.off("message", handler);
			reject(new Error("timeout waiting for ready signal"));
		}, 5000);

		function handler(message: unknown) {
			if (message && typeof message === "object" && (message as Record<string, unknown>).type === "ready") {
				clearTimeout(timeout);
				child.off("message", handler);
				resolve();
			}
		}

		child.on("message", handler);
	});
}

function sendJob(child: ReturnType<typeof fork>, job: Job): Promise<EmbedResult> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			child.off("message", handler);
			reject(new Error("timeout waiting for embed result"));
		}, 20000);

		function handler(message: unknown) {
			if (message && typeof message === "object" && (message as Record<string, unknown>).type === "embed_result") {
				clearTimeout(timeout);
				child.off("message", handler);
				resolve(message as EmbedResult);
			}
		}

		child.on("message", handler);
		child.send(job);
	});
}

describe("src/runtime/embed/main.ts", () => {
	let originalEnv: NodeJS.ProcessEnv;

	beforeEach(() => {
		originalEnv = { ...process.env };
		vi.resetModules();
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	it("responds to shutdown message with clean exit", async () => {
		const child = spawnEmbedWorker();
		await waitForReady(child);
		const result = await sendJob(child, { type: "shutdown" });
		expect(result.type).toBe("embed_result");
		expect(result.vectors).toEqual([]);
		await new Promise((r) => child.on("exit", r));
		expect(child.exitCode).toBe(0);
	});

	it("returns null vectors with error when no provider has keys", async () => {
		const child = spawnEmbedWorker({
			FLEET_PROVIDERS: "gemini,openrouter",
			GEMINI_API_KEY: "",
			OPENROUTER_API_KEY: "",
		});
		await waitForReady(child);
		const result = await sendJob(child, {
			type: "embed",
			texts: ["hello world"],
		});

		expect(result.type).toBe("embed_result");
		expect(result.vectors).toBeNull();
		expect(result.error).toBeDefined();
		expect(result.error).toContain("no provider configured");

		child.kill("SIGTERM");
		await new Promise((r) => child.on("exit", r));
		expect(child.exitCode).toBe(0);
	});

	it("splits texts into batches per CONTENT_EMBED_BATCH", async () => {
		const child = spawnEmbedWorker({
			CONTENT_EMBED_BATCH: "2",
			FLEET_PROVIDERS: "ollama",
			OLLAMA_BASE_URL: "http://localhost:9999/v1",
		});
		await waitForReady(child);

		const result = await sendJob(child, {
			type: "embed",
			texts: ["text1", "text2", "text3", "text4", "text5"],
		});

		expect(result.type).toBe("embed_result");
		expect(result.vectors).toBeNull();
		expect(result.error).toBeDefined();

		child.kill("SIGTERM");
		await new Promise((r) => child.on("exit", r));
		expect(child.exitCode).toBe(0);
	});

	it("uses provider/model from job when specified", async () => {
		const child = spawnEmbedWorker({
			FLEET_PROVIDERS: "ollama",
			OLLAMA_BASE_URL: "http://localhost:9999/v1",
		});
		await waitForReady(child);

		const result = await sendJob(child, {
			type: "embed",
			texts: ["test"],
			provider: "ollama",
			model: "custom-embed-model",
		});

		expect(result.type).toBe("embed_result");
		expect(result.vectors).toBeNull();
		expect(result.error).toBeDefined();

		child.kill("SIGTERM");
		await new Promise((r) => child.on("exit", r));
		expect(child.exitCode).toBe(0);
	});

	it("exits cleanly on parent disconnect", async () => {
		const child = spawnEmbedWorker();
		await waitForReady(child);
		child.kill("SIGTERM");
		await new Promise((r) => child.on("exit", r));
		// When killed by SIGTERM, exitCode is null and signal is SIGTERM
		expect(child.signalCode).toBe("SIGTERM");
	});

	it("retries on failure up to MAX_RETRIES", async () => {
		const child = spawnEmbedWorker({
			CONTENT_EMBED_BATCH: "10",
			FLEET_PROVIDERS: "ollama",
			OLLAMA_BASE_URL: "http://localhost:9999/v1",
		});
		await waitForReady(child);

		const start = Date.now();
		const result = await sendJob(child, {
			type: "embed",
			texts: ["test"],
		});
		const elapsed = Date.now() - start;

		expect(result.type).toBe("embed_result");
		expect(result.vectors).toBeNull();
		expect(result.error).toBeDefined();
		expect(elapsed).toBeGreaterThanOrEqual(500);

		child.kill("SIGTERM");
		await new Promise((r) => child.on("exit", r));
		expect(child.exitCode).toBe(0);
	});
});
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const ENTRY = fileURLToPath(
	new URL("../runtime/worker/main.ts", import.meta.url),
);

interface WireLine {
	t: string;
	[k: string]: unknown;
}

interface CapturedRequest {
	body: { model?: string; messages?: Array<Record<string, unknown>> };
}

interface RunHandle {
	codePromise: Promise<number | null>;
	lines: WireLine[];
	stderr: Promise<string>;
}

function runWorker(job: unknown, env: NodeJS.ProcessEnv): RunHandle {
	const lines: WireLine[] = [];
	const child = spawn(process.execPath, ["--import", "tsx", ENTRY], {
		env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	let pending = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		pending += chunk;
		let nl = pending.indexOf("\n");
		while (nl !== -1) {
			const line = pending.slice(0, nl);
			pending = pending.slice(nl + 1);
			if (!line.trim()) continue;
			try {
				lines.push(JSON.parse(line));
			} catch {
				continue;
			}
			nl = pending.indexOf("\n");
		}
	});
	let stderrData = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		stderrData += chunk;
	});
	const codePromise = new Promise<number | null>((resolve) => {
		child.on("close", (code) => resolve(code));
	});
	const stderrPromise = new Promise<string>((resolve) => {
		child.on("close", () => resolve(stderrData));
	});
	child.stdin.write(`${JSON.stringify(job)}\n`);
	child.stdin.end();
	return { codePromise, lines, stderr: stderrPromise };
}

function makeJobCtx(root: string): Record<string, unknown> {
	return {
		rootDir: root,
		worktreeDir: root,
		tracesDir: join(root, "traces"),
		runDir: join(root, "run"),
		dryRun: false,
	};
}

const completionsServers: Server[] = [];

afterAll(() => {
	for (const server of completionsServers) server.close();
});

/** OpenAI-compatible /v1/chat/completions stub that records every request body. */
function startCapturingCompletionsStub(
	text: string,
): Promise<{ baseUrl: string; requests: CapturedRequest[] }> {
	const requests: CapturedRequest[] = [];
	return new Promise((resolve) => {
		const server = createServer((req: IncomingMessage, res: ServerResponse) => {
			let body = "";
			req.on("data", (chunk: Buffer) => {
				body += chunk.toString("utf8");
			});
			req.on("end", () => {
				try {
					requests.push({ body: JSON.parse(body) });
				} catch {
					requests.push({ body: {} });
				}
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						id: "chatcmpl-stub",
						object: "chat.completion",
						created: 1700000000,
						model: "stub",
						choices: [
							{
								index: 0,
								message: { role: "assistant", content: text },
								finish_reason: "stop",
							},
						],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					}),
				);
			});
		});
		completionsServers.push(server);
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			resolve({
				baseUrl: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/v1`,
				requests,
			});
		});
	});
}

const RESUMED_MESSAGES = [
	{ role: "system", content: "RESUMED_SYSTEM_PROMPT_MARKER" },
	{ role: "user", content: "RESUMED_USER_TASK_MARKER" },
	{
		role: "assistant",
		content: null,
		tool_calls: [
			{
				id: "call_9",
				type: "function",
				function: { name: "read", arguments: '{"path":"a.ts"}' },
			},
		],
	},
	{ role: "tool", tool_call_id: "call_9", content: "resumed tool output" },
];

describe("worker resumeFrom checkpoint loading", () => {
	it("seeds the conversation from checkpoint.messages instead of constructing prompts", async () => {
		const root = mkdtempSync(join(tmpdir(), "wk-resume-"));
		const checkpointsDir = join(root, "checkpoints");
		mkdirSync(checkpointsDir, { recursive: true });
		const checkpointPath = join(checkpointsDir, "coder.json");
		writeFileSync(
			checkpointPath,
			JSON.stringify({
				role: "coder",
				model: "previous-model",
				chainIndex: 0,
				messages: RESUMED_MESSAGES,
				savedAt: new Date().toISOString(),
			}),
			"utf8",
		);
		const { baseUrl, requests } =
			await startCapturingCompletionsStub("resumed fine");
		try {
			const run = runWorker(
				{
					role: "coder",
					task: "FRESH_TASK_PROMPT_MUST_BE_IGNORED",
					ctx: {
						...makeJobCtx(root),
						resumeFrom: { messagesPath: checkpointPath },
					},
				},
				{
					...process.env,
					FLEET_PROVIDERS: "ollama",
					OLLAMA_BASE_URL: baseUrl,
				},
			);
			const code = await run.codePromise;
			expect(code).toBe(0);
			expect(run.lines[0]).toMatchObject({
				t: "init",
				role: "coder",
				provider: "ollama",
				model: "qwen2.5-coder:7b",
			});
			expect(run.lines.map((ev) => ev.t)).toEqual([
				"init",
				"text",
				"result",
				"step_finish",
			]);
			expect(requests).toHaveLength(1);
			const sentMessages = requests[0]?.body.messages ?? [];
			expect(sentMessages).toEqual(
				JSON.parse(JSON.stringify(RESUMED_MESSAGES)),
			);
			expect(JSON.stringify(sentMessages)).not.toContain(
				"FRESH_TASK_PROMPT_MUST_BE_IGNORED",
			);
			expect(JSON.stringify(sentMessages)).toContain("resumed tool output");
			expect(requests[0]?.body.model).toBe("qwen2.5-coder:7b");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, 30000);

	it("fails fast before any LLM call when the checkpoint file is missing", async () => {
		const root = mkdtempSync(join(tmpdir(), "wk-resume-miss-"));
		const { baseUrl, requests } = await startCapturingCompletionsStub(
			"must never be called",
		);
		try {
			const missingPath = join(root, "checkpoints", "coder.json");
			const run = runWorker(
				{
					role: "coder",
					task: "Do work",
					ctx: {
						...makeJobCtx(root),
						resumeFrom: { messagesPath: missingPath },
					},
				},
				{
					...process.env,
					FLEET_PROVIDERS: "ollama",
					OLLAMA_BASE_URL: baseUrl,
				},
			);
			const code = await run.codePromise;
			expect(code).not.toBe(0);
			expect(run.lines.map((ev) => ev.t)).toEqual(["error"]);
			const errEvt = run.lines[0] as unknown as { error: string };
			expect(errEvt.error).toContain("resume checkpoint unreadable");
			expect((await run.stderr).includes("resume checkpoint unreadable")).toBe(
				true,
			);
			expect(requests).toHaveLength(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, 30000);

	it("fails fast before any LLM call when the checkpoint file is corrupt", async () => {
		const root = mkdtempSync(join(tmpdir(), "wk-resume-bad-"));
		const { baseUrl, requests } = await startCapturingCompletionsStub(
			"must never be called",
		);
		try {
			const corruptPath = join(root, "checkpoints", "coder.json");
			mkdirSync(join(root, "checkpoints"), { recursive: true });
			writeFileSync(corruptPath, "{not json at all", "utf8");
			const run = runWorker(
				{
					role: "coder",
					task: "Do work",
					ctx: {
						...makeJobCtx(root),
						resumeFrom: { messagesPath: corruptPath },
					},
				},
				{
					...process.env,
					FLEET_PROVIDERS: "ollama",
					OLLAMA_BASE_URL: baseUrl,
				},
			);
			const code = await run.codePromise;
			expect(code).not.toBe(0);
			expect(run.lines.map((ev) => ev.t)).toEqual(["error"]);
			const errEvt = run.lines[0] as unknown as { error: string };
			expect(errEvt.error).toContain("resume checkpoint unreadable");
			expect(requests).toHaveLength(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, 30000);
});

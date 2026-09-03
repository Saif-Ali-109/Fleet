import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashAgentDef } from "../db/audit.ts";
import { encodePolicyDocument, type PolicyDocument } from "../fleet/policy.ts";
import type { FleetAgentDef, ToolName } from "../fleet/types.ts";
import {
	parsePolicyEnv,
	planWorkerPolicy,
	type WorkerPolicyPlan,
	type WorkerPolicySnapshot,
} from "../runtime/worker/main.ts";

const WORKER_ENTRY = fileURLToPath(
	new URL("../runtime/worker/main.ts", import.meta.url),
);

// A parsed newline-delimited wire event from the forked worker's stdout.
interface WireLine {
	t: string;
	[k: string]: unknown;
}

// P4.6/P4.7 coverage (plan-sor.md §C10): the worker's env snapshot parsing and
// effective-registry build (spec §9.7 / §9.1 P-I1). sourceHash is computed
// worker-side via hashAgentDef(def) and carried into the policy_state payload.

const DEF: FleetAgentDef = {
	name: "coder",
	systemPrompt: "system prompt",
	tools: ["read", "write"] as unknown as ToolName[],
	mcpAllow: ["mcp_fetch"],
	skillsDir: "skills/coder",
};

const INTERSECTION: PolicyDocument = {
	schemaVersion: 1,
	meta: { subject_role: "coder" },
	allowedTools: ["read"],
	mcpAllow: ["mcp_fetch"],
	toolRules: { read: [] },
};

function sorSnapshot(
	overrides?: Partial<WorkerPolicySnapshot>,
): WorkerPolicySnapshot {
	return {
		mode: "sor",
		policyVersion: 3,
		policyHash: "policy-hash-3",
		document: INTERSECTION,
		...overrides,
	};
}

describe("parsePolicyEnv (P4.6/P4.7 mode honesty)", () => {
	it("absent SOR_POLICY_* env declares compatibility with a null snapshot", () => {
		const snapshot = parsePolicyEnv({});
		expect(snapshot).toEqual({
			mode: "compatibility",
			policyVersion: null,
			policyHash: null,
			document: null,
		});
	});

	it("sor env decodes mode, version, hash and the SOR_POLICY_JSON_B64 document", () => {
		const snapshot = parsePolicyEnv({
			SOR_POLICY_MODE: "sor",
			SOR_POLICY_VERSION: "3",
			SOR_POLICY_HASH: "policy-hash-3",
			SOR_POLICY_JSON_B64: encodePolicyDocument(INTERSECTION),
		});
		expect(snapshot.mode).toBe("sor");
		expect(snapshot.policyVersion).toBe(3);
		expect(snapshot.policyHash).toBe("policy-hash-3");
		expect(snapshot.document).toEqual(INTERSECTION);
	});

	it("an unsupported mode string degrades to declared compatibility (never a wrong grant)", () => {
		const snapshot = parsePolicyEnv({ SOR_POLICY_MODE: "tampered" });
		expect(snapshot.mode).toBe("compatibility");
		expect(snapshot.document).toBeNull();
	});

	it("a malformed version parses as null (left to the planner to fail closed)", () => {
		expect(
			parsePolicyEnv({ SOR_POLICY_MODE: "sor", SOR_POLICY_VERSION: "12abc" })
				.policyVersion,
		).toBeNull();
		expect(
			parsePolicyEnv({ SOR_POLICY_MODE: "sor", SOR_POLICY_VERSION: "-1" })
				.policyVersion,
		).toBeNull();
		expect(
			parsePolicyEnv({
				SOR_POLICY_MODE: "sor",
				SOR_POLICY_VERSION: "99999999999999999999",
			}).policyVersion,
		).toBeNull();
	});

	it("an undecodable SOR_POLICY_JSON_B64 warns and drops the document (P-I3 material)", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const snapshot = parsePolicyEnv({
				SOR_POLICY_MODE: "sor",
				SOR_POLICY_JSON_B64: "!!!not-valid-b64!!!",
			});
			expect(snapshot.mode).toBe("sor");
			expect(snapshot.document).toBeNull();
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining("[sor] policy document skipped"),
			);
		} finally {
			warn.mockRestore();
		}
	});
});

describe("planWorkerPolicy (P4.6 effective registry = ceiling ∩ grant)", () => {
	function expectHashCarried(plan: WorkerPolicyPlan, def: FleetAgentDef): void {
		expect(plan.sourceHash).toBe(hashAgentDef(def));
	}

	it("compatibility keeps static def.tools and carries the def sourceHash", () => {
		const plan = planWorkerPolicy(DEF, {
			mode: "compatibility",
			policyVersion: null,
			policyHash: null,
			document: null,
		});
		expect(plan.mode).toBe("compatibility");
		expect(plan.tools).toEqual(["read", "write"]);
		expect(plan.mcpAllow).toEqual(["mcp_fetch"]);
		expect(plan.toolRules).toEqual({});
		expect(plan.policyVersion).toBeNull();
		expect(plan.policyHash).toBeNull();
		expectHashCarried(plan, DEF);
	});

	it("sor builds the intersection and carries version/hash/sourceHash", () => {
		const plan = planWorkerPolicy(DEF, sorSnapshot());
		expect(plan.mode).toBe("sor");
		expect(plan.tools).toEqual(["read"]);
		expect(plan.mcpAllow).toEqual(["mcp_fetch"]);
		expect(plan.toolRules).toEqual(INTERSECTION.toolRules);
		expect(plan.policyVersion).toBe(3);
		expect(plan.policyHash).toBe("policy-hash-3");
		expectHashCarried(plan, DEF);
	});

	it("a grant alone cannot add a tool outside the ceiling (AT-4: code capability ceiling is never exceeded)", () => {
		const plan = planWorkerPolicy(
			DEF,
			sorSnapshot({
				document: {
					schemaVersion: 1,
					meta: { subject_role: "coder" },
					allowedTools: ["bash"],
					mcpAllow: ["unlisted_mcp"],
					toolRules: {},
				},
			}),
		);
		expect(plan.mode).toBe("sor");
		expect(plan.tools).toEqual([]);
		expect(plan.mcpAllow).toEqual([]);
	});

	it("sor with a missing document falls back to fail-closed (P-I3, zero grants)", () => {
		const plan = planWorkerPolicy(DEF, sorSnapshot({ document: null }));
		expect(plan.mode).toBe("fail-closed");
		expect(plan.tools).toEqual([]);
		expect(plan.mcpAllow).toEqual([]);
	});

	it("sor with a role-mismatched document fails closed, never degradation to compatibility", () => {
		const plan = planWorkerPolicy(
			DEF,
			sorSnapshot({
				document: {
					...INTERSECTION,
					meta: { subject_role: "planner" },
				},
			}),
		);
		expect(plan.mode).toBe("fail-closed");
		expect(plan.tools).toEqual([]);
		expect(plan.mcpAllow).toEqual([]);
	});

	it("fail-closed yields zero tools even when a document rides along; rules stay for evidence", () => {
		const plan = planWorkerPolicy(DEF, {
			mode: "fail-closed",
			policyVersion: 1,
			policyHash: "h",
			document: INTERSECTION,
		});
		expect(plan.mode).toBe("fail-closed");
		expect(plan.tools).toEqual([]);
		expect(plan.mcpAllow).toEqual([]);
		expect(plan.toolRules).toEqual(INTERSECTION.toolRules);
		expectHashCarried(plan, DEF);
	});
});

// P4.7: the dry-run/stub session must emit NO policy_state and attempt ZERO
// policy DB-appends even when DATABASE_URL and full SOR_POLICY_* env are
// configured (mirrors the emitWakeup no-op). The dry branch in run() returns
// BEFORE any emitPolicyState/appendPolicyEventNonFatal call; this forks the
// real worker to prove it end-to-end, asserting the exact wire-event list and
// that stderr carries no "[sor]" skip warning.
describe("dry-run worker makes zero policy DB-appends with a configured DB (P4.7)", () => {
	interface DryRunResult {
		code: number | null;
		lines: WireLine[];
		stderr: string;
	}

	function forkDryRun(
		job: unknown,
		env: NodeJS.ProcessEnv,
	): Promise<DryRunResult> {
		return new Promise((resolve) => {
			const lines: WireLine[] = [];
			let stderr = "";
			let pending = "";
			const child = spawn(process.execPath, ["--import", "tsx", WORKER_ENTRY], {
				env,
				stdio: ["pipe", "pipe", "pipe"],
			});
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				pending += chunk;
				let nl = pending.indexOf("\n");
				while (nl !== -1) {
					const line = pending.slice(0, nl);
					pending = pending.slice(nl + 1);
					if (!line.trim()) continue;
					let ev: WireLine;
					try {
						ev = JSON.parse(line);
					} catch {
						continue;
					}
					lines.push(ev);
					nl = pending.indexOf("\n");
				}
			});
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk: string) => {
				stderr += chunk;
			});
			child.on("close", (code) => {
				resolve({ code, lines, stderr });
			});
			child.stdin.end(`${JSON.stringify(job)}\n`);
		});
	}

	function jobCtx(root: string): Record<string, unknown> {
		return {
			rootDir: root,
			worktreeDir: root,
			tracesDir: join(root, "traces"),
			runDir: join(root, "run"),
			dryRun: true,
		};
	}

	it("forked dry worker with DATABASE_URL + SOR_POLICY_MODE=sor emits init/text/result/step_finish only, exit 0, zero policy warnings", async () => {
		const root = mkdtempSync(join(tmpdir(), "wk-policy-dry-"));
		const env: NodeJS.ProcessEnv = {
			...process.env,
			FLEET_PROVIDERS: "ollama",
			OLLAMA_BASE_URL: "http://127.0.0.1:9/v1",
			// A real-ish configured DB that the dry path must never touch.
			DATABASE_URL: "postgresql://user:pw@127.0.0.1:9/nope?sslmode=disable",
			SOR_POLICY_MODE: "sor",
			SOR_POLICY_VERSION: "3",
			SOR_POLICY_HASH: "policy-hash-3",
			SOR_POLICY_JSON_B64: encodePolicyDocument(INTERSECTION),
		};
		try {
			const result = await forkDryRun(
				{
					role: "coder",
					task: "Dry task",
					ctx: jobCtx(root),
				},
				env,
			);
			expect(result.code).toBe(0);
			expect(result.lines.map((ev) => ev.t)).toEqual([
				"init",
				"text",
				"result",
				"step_finish",
			]);
			// No policy_state event, and no "[sor] policy_state/decision skipped"
			// warning — i.e. zero policy DB-appends were even attempted.
			expect(result.stderr).not.toMatch(
				/\[sor\].*(policy_state|policy_decision)/,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, 30000);
});

// Cross-step reconciliation (Step 7 worker + Step 8 loop + Step 10 append):
// a REAL forked worker in `sor` mode whose (mocked) LLM calls a tool that is
// NOT in the policy grant must route through evaluateToolCall → the worker's
// policyDecision callback → appendPolicyEventNonFatal. With a configured but
// unreachable DB the appends fail NON-FATAL (P-I5): the worker still exits 0,
// the tool is denied side-effectless in the loop, and both skips are warned —
// a denied tool is denied regardless of audit success.
describe("live sor-mode worker wires the policyDecision callback (Step 7 ↔ Step 8)", () => {
	const servers: Array<{ close: () => void }> = [];
	afterEach(() => {
		for (const s of servers) s.close();
		servers.length = 0;
	});

	function startCompletionsStub(
		responder: () => Record<string, unknown>,
	): Promise<string> {
		return new Promise((resolve) => {
			const server = createServer(
				(req: IncomingMessage, res: ServerResponse) => {
					let _body = "";
					req.on("data", (chunk: Buffer) => {
						_body += chunk.toString("utf8");
					});
					req.on("end", () => {
						setTimeout(() => {
							res.writeHead(200, { "Content-Type": "application/json" });
							res.end(JSON.stringify(responder()));
						}, 5);
					});
				},
			);
			servers.push(server);
			server.listen(0, "127.0.0.1", () => {
				const addr = server.address();
				resolve(
					`http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/v1`,
				);
			});
		});
	}

	function forkLive(
		job: unknown,
		env: NodeJS.ProcessEnv,
	): {
		codePromise: Promise<number | null>;
		lines: WireLine[];
		stderrPromise: Promise<string>;
	} {
		const lines: WireLine[] = [];
		let stderr = "";
		let resolveErr: (v: string) => void;
		const stderrPromise = new Promise<string>((r) => {
			resolveErr = r;
		});
		let pending = "";
		const child = spawn(process.execPath, ["--import", "tsx", WORKER_ENTRY], {
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			pending += chunk;
			let nl = pending.indexOf("\n");
			while (nl !== -1) {
				const line = pending.slice(0, nl);
				pending = pending.slice(nl + 1);
				if (!line.trim()) continue;
				let ev: WireLine;
				try {
					ev = JSON.parse(line);
				} catch {
					continue;
				}
				lines.push(ev);
				nl = pending.indexOf("\n");
			}
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("close", () => {
			resolveErr(stderr);
		});
		const codePromise = new Promise<number | null>((resolve) => {
			child.on("close", (code) => resolve(code));
		});
		child.stdin.end(`${JSON.stringify(job)}\n`);
		return { codePromise, lines, stderrPromise };
	}

	function liveJobCtx(root: string): Record<string, unknown> {
		return {
			rootDir: root,
			worktreeDir: root,
			tracesDir: join(root, "traces"),
			runDir: join(root, "run"),
			dryRun: false,
		};
	}

	it("sor mode: a denied tool yields side-effectless DENY and both appends warn non-fatally, exit 0", async () => {
		const root = mkdtempSync(join(tmpdir(), "wk-policy-live-"));
		let calls = 0;
		const baseUrl = await startCompletionsStub(() => {
			calls += 1;
			if (calls === 1) {
				return {
					id: "chatcmpl-stub",
					object: "chat.completion",
					created: 1700000000,
					model: "stub",
					choices: [
						{
							index: 0,
							message: {
								role: "assistant",
								content: null,
								tool_calls: [
									{
										id: "call_1",
										type: "function",
										function: {
											name: "bash",
											arguments: JSON.stringify({ command: "rm -rf /" }),
										},
									},
								],
							},
							finish_reason: "tool_calls",
						},
					],
					usage: {},
				};
			}
			return {
				id: "chatcmpl-stub",
				object: "chat.completion",
				created: 1700000000,
				model: "stub",
				choices: [
					{
						index: 0,
						message: {
							role: "assistant",
							content: "denied and recovered",
							finish_reason: "stop",
						},
					},
				],
				usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
			};
		});
		try {
			const { codePromise, lines, stderrPromise } = forkLive(
				{
					role: "coder",
					task: "Live policy task",
					ctx: liveJobCtx(root),
				},
				{
					...process.env,
					FLEET_PROVIDERS: "ollama",
					OLLAMA_BASE_URL: baseUrl,
					DATABASE_URL: "postgresql://user:pw@127.0.0.1:9/nope?sslmode=disable",
					SOR_POLICY_MODE: "sor",
					SOR_POLICY_VERSION: "1",
					SOR_POLICY_HASH: "h",
					SOR_POLICY_JSON_B64: encodePolicyDocument({
						schemaVersion: 1,
						meta: { subject_role: "coder" },
						allowedTools: ["read"],
						mcpAllow: [],
						toolRules: {},
					}),
				},
			);
			const code = await codePromise;
			expect(code).toBe(0);
			expect(calls).toBe(2);
			// Effective sor registry exposes read only; the stub's bash call is
			// denied side-effectless (no bash impl exists, DENY before any exec).
			const toolResults = lines.filter(
				(l): l is WireLine & { name: string; ok: boolean } =>
					l.t === "tool_result",
			);
			expect(toolResults.length).toBeGreaterThanOrEqual(1);
			const denied = toolResults.find((tr) => tr.name === "bash");
			expect(denied).toBeDefined();
			expect(denied?.ok).toBe(false);
			const stderr = await stderrPromise;
			// The policyDecision hook was wired end-to-end: with a configured but
			// unreachable DB both appends failed NON-FATAL (P-I5) and were warned —
			// the run still completed and the deny still held.
			expect(stderr).toMatch(/\[sor\] policy_state skipped/);
			expect(stderr).toMatch(/\[sor\] policy_decision skipped/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, 60000);
});

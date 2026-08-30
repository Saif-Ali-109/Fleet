import { type ChildProcess, fork } from "node:child_process";
import {
	closeSync,
	existsSync,
	fstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	appendAuditEvent,
	ensureChain,
	loadRolePolicy,
	type LoadedRolePolicy,
} from "./db/audit.ts";
import { pool } from "./db/client.ts";
import { canonicalPolicyHash, emptyPolicy } from "./fleet/policy.ts";
import { emitQuotaEvent } from "./fleet/quotaEvents.ts";
import { parseRateLimitSwitch, RPD_EXHAUSTED } from "./fleet/quotaSignals.ts";
import {
	assertGeminiQuotaConfiguration,
	geminiQuotaConfig,
	geminiRateLimitWaitMs,
} from "./gemini/quotaConfig.ts";
import { GeminiQuotaCoordinator } from "./gemini/quotaCoordinator.ts";
import {
	type ProviderAttemptOutcome,
	withProviderFallback,
} from "./providers/registry.ts";
import { parseProviderTrace } from "./runner/providers.ts";
import type { PolicyMode } from "./sor/kernel/types.ts";
import { MANAGER_ID, newRequestId } from "./telemetry.ts";
import type {
	AgentResult,
	ProviderName,
	Role,
	RolePolicy,
	RunContext,
} from "./types.ts";
import { hireWorker, updateWorkerStatus } from "./workforce/hiring.ts";
import { loadPolicy } from "./workforce/policy.ts";

export interface RunWorkerOpts {
	/** Reasoning-effort variant override (else policy.variant). */
	variant?: RolePolicy["variant"];
	/** Called for every assistant text chunk (for the live TUI). */
	onText?: (chunk: string) => void;
	/** Called for every worker wire event (thinking, tool calls, results, etc.). */
	onEvent?: (ev: Record<string, unknown>) => void;
	/** Reviewer-findings injection only (SPEC §6); forwarded verbatim into the job ctx. */
	extraTask?: string;
}

export interface ParsedStream {
	text: string;
	sessionID: string | null;
	model?: string;
	tokens: AgentResult["tokens"];
	costUsd: number;
	sawError: boolean;
	errorMsg?: string;
	lastBashExitCode?: number;
	bashCommands?: Array<{ command: string; exitCode?: number }>;
	tools: number;
	models: number;
	skills: number;
	breakdown: Record<string, number>;
}

// Live worker child processes + user-abort flag (dashboard Stop button).
// killActiveWorkers() SIGTERMs every in-flight worker and latches the flag so
// runWorker fails fast instead of falling through the provider fallback pool.
const liveChildren = new Set<ChildProcess>();
let abortRequested = false;
let geminiCoordinator: GeminiQuotaCoordinator | undefined;
let geminiCoordinatorConfigKey: string | undefined;

// PAUSE-on-exhaustion gate (SPEC §11.5): when every Gemini chain model is
// rpd-latched the walk parks on this waiter instead of failing the role; the
// orchestrator's Resume flow resets the coordinator buckets, then resolves it.
let resumeWaiter: { promise: Promise<void>; resolve: () => void } | null = null;

/** Resolve the active quota-pause waiter. False when no walk is paused. */
export function requestQuotaResume(): boolean {
	if (!resumeWaiter) return false;
	resumeWaiter.resolve();
	return true;
}

/** True while at least one Gemini chain walk is parked in quota pause. */
export function isQuotaPaused(): boolean {
	return !!resumeWaiter;
}

function quotaCoordinator(): GeminiQuotaCoordinator {
	geminiRateLimitWaitMs();
	const limits = geminiQuotaConfig();
	assertGeminiQuotaConfiguration(undefined, limits);
	const configKey = JSON.stringify(
		Object.entries(limits).sort(([a], [b]) => a.localeCompare(b)),
	);
	if (!geminiCoordinator || geminiCoordinatorConfigKey !== configKey) {
		geminiCoordinator = new GeminiQuotaCoordinator(limits);
		geminiCoordinatorConfigKey = configKey;
	}
	return geminiCoordinator;
}

/**
 * Reset every GeminiQuotaCoordinator bucket (new key ⇒ fresh quotas). Called by
 * the orchestrator's Resume flow BEFORE requestQuotaResume() so the restarted
 * chain walks against clean rpm/tpm/rpd accounting.
 */
export function resetGeminiQuotaCoordinator(): void {
	quotaCoordinator().resetAll();
}

/** Kill every in-flight worker process and latch the abort flag. Returns the number killed. */
export function killActiveWorkers(): number {
	abortRequested = true;
	let n = 0;
	for (const child of [...liveChildren]) {
		try {
			child.kill("SIGTERM");
			n += 1;
		} catch {
			// already dead; close handler removes it
		}
	}
	return n;
}

/** Clear the abort latch (call when starting a new run/queue). */
export function resetWorkerAbort(): void {
	abortRequested = false;
}

const DEFAULT_WORKER_ENTRY = fileURLToPath(
	new URL("./runtime/worker/main.ts", import.meta.url),
);

/**
 * Worker entry point. FLEET_WORKER_ENTRY is a PERMANENT TEST-ONLY seam: it is
 * never set by any production code path and exists solely so tests can fork a
 * stub worker program instead of the real runtime/worker/main.ts entry.
 */
function workerEntry(): string {
	return process.env.FLEET_WORKER_ENTRY
		? resolve(process.env.FLEET_WORKER_ENTRY)
		: DEFAULT_WORKER_ENTRY;
}

/**
 * The ONE worker fork call site (SPEC §6): the `.ts` entry needs the tsx
 * loader (`--import tsx`, Node ≥22), stdout/stderr fds redirect straight into
 * the trace files so one stream IS trace capture AND event source, and stdin
 * is a pipe that receives ONE JSON job.
 */
function forkWorker(params: {
	entry: string;
	env: NodeJS.ProcessEnv;
	fdOut: number;
	fdErr: number;
}): ChildProcess {
	return fork(params.entry, {
		execPath: process.execPath,
		execArgv: [...process.execArgv, "--import", "tsx"],
		stdio: ["pipe", params.fdOut, params.fdErr, "ipc"],
		env: params.env,
	});
}

/**
 * True when a worker terminal error signals a transient network / timeout
 * failure (missing HTTP status, SDK connection timeout, socket errors, …).
 * The manager walks the model chain on these exactly like on a 5xx status,
 * since the worker already exhausted its own retry ladder before surfacing it.
 */
export function isTransientNetworkError(msg: string): boolean {
	return (
		/APIConnectionTimeoutError/i.test(msg) ||
		/\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|Connection error|fetch failed|socket hang up|network error)\b/i.test(
			msg,
		) ||
		/timed?\s*out|headersTimeout/i.test(msg)
	);
}

/** Run one worker for `role`, honoring an explicit context provider when set. */
export async function runWorker(
	role: Role,
	task: string,
	ctx: RunContext,
	policy: RolePolicy,
	opts: RunWorkerOpts = {},
): Promise<AgentResult> {
	const tracePath = join(ctx.tracesDir, `${role}.jsonl`);
	await mkdir(dirname(tracePath), { recursive: true });
	const startedAt = Date.now();

	if (ctx.dryRun) {
		return stubResult(
			role,
			policy.model,
			tracePath,
			startedAt,
			ctx.provider ?? "gemini",
		);
	}

	let workerDbId: string | undefined;
	try {
		const workforcePolicy = loadPolicy();
		workerDbId = await hireWorker(
			role,
			ctx.provider ?? "gemini",
			policy.model,
			workforcePolicy,
		);
	} catch (err) {
		if (err instanceof Error && err.message.startsWith("Cannot hire")) {
			return finalize(
				role,
				policy.model,
				emptyStream(),
				tracePath,
				startedAt,
				false,
				err.message,
				[],
				ctx.provider ?? "gemini",
			);
		}
	}
	// Every Gemini spawnOnce lands here (across restart cycles) so that
	// AgentResult.attempts reflects each individual model attempt.
	const geminiAttempts: NonNullable<AgentResult["attempts"]> = [];

	/** Sleep out a finite quota block, bailing early when the user hits Stop. */
	const quotaWait = async (waitMs: number): Promise<void> => {
		if (waitMs <= 0) return;
		const deadline = Date.now() + waitMs;
		while (!abortRequested && Date.now() < deadline) {
			await new Promise((r) =>
				setTimeout(r, Math.min(100, deadline - Date.now())),
			);
		}
	};

	/**
	 * Gemini chain walk (PLAN.md "Rate-limit fallback system"): any rpm/tpm/rpd
	 * block switches to the next chain model immediately; once the whole chain
	 * is finitely blocked, sleep min(needed wait, ceiling) and restart from the
	 * top (automatic fail-back); all-RPD-dead halts the walk.
	 */
	const geminiChainWalk = async (): Promise<
		ProviderAttemptOutcome<ParsedStream>
	> => {
		const models = [...new Set([policy.model, ...policy.fallbacks])];
		const checkpointPath = join(ctx.runDir, "checkpoints", `${role}.json`);
		let resumeMessagesPath: string | undefined;
		const ceiling = geminiRateLimitWaitMs();
		let last: ParsedStream | undefined;
		let lastModel = policy.model;
		let zeroWaitCycles = 0;
		const everBlocked = new Set<string>();
		for (;;) {
			const finiteBlocks = new Map<string, number>();
			const rpdDead = new Set<string>();
			for (let i = 0; i < models.length; i++) {
				const model = models[i];
				if (!model) continue;
				if (abortRequested) {
					return { model: lastModel, ok: false, error: "aborted by user" };
				}
				const parsed = await spawnOnce(
					"gemini",
					role,
					task,
					ctx,
					opts.extraTask,
					tracePath,
					opts,
					model,
					resumeMessagesPath,
				);
				last = parsed;
				lastModel = parsed.model ?? model;
				const ok =
					!parsed.sawError && !abortRequested && parsed.text.trim().length > 0;
				geminiAttempts.push({
					model: parsed.model ?? model,
					ok,
					...(ok || parsed.errorMsg === undefined
						? {}
						: { error: parsed.errorMsg }),
					provider: "gemini",
				});
				if (ok) {
					if (everBlocked.delete(model)) {
						emitQuotaEvent({
							type: "model_recovered",
							role,
							provider: "gemini",
							model,
						});
					}
					return { model: parsed.model ?? model, ok: true, value: parsed };
				}
				const sw = parseRateLimitSwitch(parsed.errorMsg);
				if (sw) {
					finiteBlocks.set(model, sw.waitMs);
					everBlocked.add(model);
					if (i + 1 < models.length) {
						emitQuotaEvent({
							type: "model_switch",
							role,
							provider: "gemini",
							fromModel: model,
							toModel: models[i + 1] ?? "",
							block: sw.block,
							waitMs: sw.waitMs,
						});
					}
					continue;
				}
				if (parsed.errorMsg === RPD_EXHAUSTED) {
					rpdDead.add(model);
					if (i + 1 < models.length) {
						emitQuotaEvent({
							type: "model_switch",
							role,
							provider: "gemini",
							fromModel: model,
							toModel: models[i + 1] ?? "",
							block: "rpd",
							waitMs: 0,
						});
					}
					continue;
				}
				if (/^\d{3}\s/.test(parsed.errorMsg ?? "")) {
					if (i + 1 < models.length) {
						emitQuotaEvent({
							type: "model_switch",
							role,
							provider: "gemini",
							fromModel: model,
							toModel: models[i + 1] ?? "",
							block: "http",
							waitMs: 0,
						});
					}
					continue;
				}
				if (isTransientNetworkError(parsed.errorMsg ?? "")) {
					if (i + 1 < models.length) {
						emitQuotaEvent({
							type: "model_switch",
							role,
							provider: "gemini",
							fromModel: model,
							toModel: models[i + 1] ?? "",
							block: "timeout",
							waitMs: 0,
						});
						continue;
					}
				}
				const temporary =
					parsed.errorMsg === "GEMINI_RATE_LIMIT_WAIT_EXCEEDED" ||
					parsed.errorMsg === "GEMINI_RATE_LIMIT_WAIT_CEILING";
				return {
					model: lastModel,
					ok: false,
					value: parsed,
					error: parsed.errorMsg,
					stopFallback: temporary,
				};
			}
			if (rpdDead.size === models.length) {
				emitQuotaEvent({
					type: "all_models_exhausted",
					role,
					provider: "gemini",
					models,
				});
				// PAUSE-on-exhaustion (SPEC §11.5): quota can never kill a run. Park
				// the walk until the orchestrator's Resume flow resolves the waiter
				// (buckets already reset) or the user Stops, then restart the chain
				// FROM THE TOP seeded with the role's checkpoint so the LLM continues
				// mid-conversation. A second all-RPD pass re-enters pause (loop-safe).
				if (!resumeWaiter) {
					let resolveWaiter: (() => void) | undefined;
					const promise = new Promise<void>((r) => {
						resolveWaiter = r;
					});
					if (!resolveWaiter) throw new Error("resolveWaiter not set");
					resumeWaiter = { promise, resolve: resolveWaiter };
				}
				const waiter = resumeWaiter;
				if (!waiter) throw new Error("waiter not set");
				let resumed = false;
				void waiter.promise.then(() => {
					resumed = true;
				});
				while (!resumed && !abortRequested) {
					await quotaWait(500);
				}
				resumeWaiter = null;
				if (!resumed) {
					// User Stop during the pause: finalize failed through the normal path.
					return {
						model: lastModel,
						ok: false,
						value: last,
						error: "aborted by user",
						stopFallback: true,
					};
				}
				resumeMessagesPath = existsSync(checkpointPath)
					? checkpointPath
					: undefined;
				zeroWaitCycles = 0;
				continue;
			}
			if (finiteBlocks.size === 0 && rpdDead.size === 0) break;
			if (abortRequested) break;
			const wait = Math.min(...finiteBlocks.values(), ceiling);
			if (wait <= 0) {
				zeroWaitCycles += 1;
				if (zeroWaitCycles >= 2) break;
			} else {
				zeroWaitCycles = 0;
			}
			await quotaWait(wait);
		}
		return {
			model: lastModel,
			ok: false,
			value: last,
			error: last?.errorMsg ?? "all configured Gemini models quota exhausted",
		};
	};

	const walk = await withProviderFallback<ParsedStream>(
		role,
		async (provider) => {
			if (abortRequested) {
				// User hit Stop: fail fast without forking or falling back.
				return { model: policy.model, ok: false, error: "aborted by user" };
			}
			if (provider !== "gemini") {
				let last: ParsedStream | undefined;
				for (const model of [policy.model]) {
					const parsed = await spawnOnce(
						provider,
						role,
						task,
						ctx,
						opts.extraTask,
						tracePath,
						opts,
						model,
					);
					last = parsed;
					const ok =
						!parsed.sawError &&
						!abortRequested &&
						parsed.text.trim().length > 0;
					if (ok)
						return { model: parsed.model ?? model, ok: true, value: parsed };
					if (parsed.errorMsg === RPD_EXHAUSTED) continue;
					const temporary =
						parsed.errorMsg === "GEMINI_RATE_LIMIT_WAIT_EXCEEDED" ||
						parsed.errorMsg === "GEMINI_RATE_LIMIT_WAIT_CEILING";
					return {
						model: parsed.model ?? model,
						ok: false,
						value: parsed,
						error: parsed.errorMsg,
						stopFallback: temporary,
					};
				}
				return {
					model: last?.model ?? policy.model,
					ok: false,
					value: last,
					error:
						last?.errorMsg ?? "all configured Gemini models quota exhausted",
				};
			}
			return geminiChainWalk();
		},
		ctx.provider ? [ctx.provider] : undefined,
	);

	const mappedWalkAttempts = walk.attempts.map((a) => ({
		model: a.model,
		ok: a.ok,
		...(a.error !== undefined ? { error: a.error } : {}),
		...(a.provider !== null ? { provider: a.provider } : {}),
	}));
	const firstGeminiAttempt = mappedWalkAttempts.findIndex(
		(a) => a.provider === "gemini",
	);
	const attempts: NonNullable<AgentResult["attempts"]> =
		geminiAttempts.length === 0
			? mappedWalkAttempts
			: firstGeminiAttempt === -1
				? [...mappedWalkAttempts, ...geminiAttempts]
				: [
						...mappedWalkAttempts.slice(0, firstGeminiAttempt),
						...geminiAttempts,
						...mappedWalkAttempts
							.slice(firstGeminiAttempt + 1)
							.filter((a) => a.provider !== "gemini"),
					];

	if (workerDbId) {
		try {
			await updateWorkerStatus(
				workerDbId,
				walk.ok ? "success" : "failed",
				tracePath,
			);
		} catch {
			/* non-fatal */
		}
	}

	return finalize(
		role,
		walk.ok ? walk.model : (attempts[attempts.length - 1]?.model ?? walk.model),
		walk.value ?? emptyStream(),
		tracePath,
		startedAt,
		walk.ok,
		walk.ok ? undefined : (walk.error ?? "all providers failed"),
		attempts,
		walk.provider ?? ctx.provider ?? "gemini",
	);
}

// ---- Policy mode resolution (plan-sor.md §C5/C8.2; spec §9.5, §9.7) ----
// Pure + injectable: the DB read arrives as an injected `loadRolePolicy`, so
// every branch is unit-testable without a live Postgres (P5.6).

export interface PolicyModeResolution {
	mode: PolicyMode;
	/** Row `policy_version` — set in `sor`, omitted in compatibility/fail-closed. */
	policyVersion?: number;
	/** Validated document hash — `sor` row hash, or the empty-grant sentinel in `fail-closed`. */
	policyHash?: string;
	/** JSON text of the document injected as `SOR_POLICY_JSON_B64` (`sor`/`fail-closed`). */
	documentJson?: string;
	/** True only for the configured+reachable-but-zero-rows case (P-I4 mode honesty). */
	absent?: boolean;
}

export type LoadRolePolicyLike = (role: Role) => Promise<LoadedRolePolicy>;

export interface ResolvePolicyModeOpts {
	role: Role;
	/** Injected SOR-config check (DATABASE_URL present / policy subsystem enabled). */
	sorConfigured: () => boolean;
	/** Injected DB read — rejects when a configured DB is unreachable. */
	loadRolePolicy: LoadRolePolicyLike;
}

/** SOR policy is configured whenever DATABASE_URL is set (no disable flag exists). */
export function isSorPolicyConfigured(): boolean {
	return (
		typeof process.env.DATABASE_URL === "string" &&
		process.env.DATABASE_URL.length > 0
	);
}

/** fail-closed snapshot: a valid zero-grant document + its canonical hash sentinel. */
function failClosedSnapshot(role: Role): PolicyModeResolution {
	const doc = emptyPolicy(role);
	return {
		mode: "fail-closed",
		policyHash: canonicalPolicyHash(doc),
		documentJson: JSON.stringify(doc),
	};
}

/**
 * Resolve the per-session policy mode at spawn (§9.5, locked order):
 * no SOR config ⇒ compatibility; valid row ⇒ sor; zero rows ⇒ compatibility
 * (P-I4, never fail-closed); invalid/tampered row or unreachable DB ⇒ fail-closed.
 */
export async function resolvePolicyMode(
	opts: ResolvePolicyModeOpts,
): Promise<PolicyModeResolution> {
	const { role, sorConfigured, loadRolePolicy } = opts;
	if (!sorConfigured()) {
		return { mode: "compatibility" };
	}
	let loaded: LoadedRolePolicy;
	try {
		loaded = await loadRolePolicy(role);
	} catch {
		// Configured but unreachable: fail closed, never compatibility (§9.5).
		return failClosedSnapshot(role);
	}
	if (loaded.status === "absent") {
		// No row / seed failed: genuine absence ⇒ declared compatibility (P-I4).
		return { mode: "compatibility", absent: true };
	}
	if (loaded.status === "invalid") {
		return failClosedSnapshot(role);
	}
	return {
		mode: "sor",
		policyVersion: loaded.policy.policyVersion,
		policyHash: loaded.policy.policyHash,
		documentJson: JSON.stringify(loaded.policy.document),
	};
}

/** Env entries for the worker fork; compatibility injects nothing (the worker declares it). */
export function policyForkEnv(
	resolved: PolicyModeResolution,
): Record<string, string> {
	if (resolved.mode === "compatibility") return {};
	const env: Record<string, string> = { SOR_POLICY_MODE: resolved.mode };
	if (resolved.policyHash !== undefined) {
		env.SOR_POLICY_HASH = resolved.policyHash;
	}
	if (resolved.policyVersion !== undefined) {
		env.SOR_POLICY_VERSION = String(resolved.policyVersion);
	}
	if (resolved.documentJson !== undefined) {
		env.SOR_POLICY_JSON_B64 = Buffer.from(
			resolved.documentJson,
			"utf8",
		).toString("base64");
	}
	return env;
}

/** Fork one worker attempt for `provider` and parse its trace slice into a ParsedStream. */
export async function spawnOnce(
	provider: ProviderName,
	role: Role,
	task: string,
	ctx: RunContext,
	extraTask: string | undefined,
	tracePath: string,
	opts: RunWorkerOpts,
	modelOverride?: string,
	resumeFromPath?: string,
): Promise<ParsedStream> {
	const policyEnv = policyForkEnv(
		await resolvePolicyMode({
			role,
			sorConfigured: isSorPolicyConfigured,
			loadRolePolicy: (r) => loadRolePolicy(pool, r),
		}),
	);
	return new Promise((resolve) => {
		const quota = provider === "gemini" ? quotaCoordinator() : undefined;
		const workerId = newRequestId();
		const traceDir = dirname(tracePath);
		mkdirSync(traceDir, { recursive: true });
		const stderrPath = join(traceDir, `${role}.stderr.log`);
		const eventsDir = join(ctx.runDir, "events");
		try {
			mkdirSync(eventsDir, { recursive: true });
		} catch {
			// non-fatal: the worker creates it lazily if needed
		}
		let fdOut: number | undefined;
		let fdErr: number | undefined;
		let workerSessionId: string | undefined;
		try {
			fdOut = openSync(tracePath, "a");
			fdErr = openSync(stderrPath, "a");
		} catch (err) {
			try {
				if (fdOut !== undefined) closeSync(fdOut);
			} catch {
				// already closed
			}
			try {
				if (fdErr !== undefined) closeSync(fdErr);
			} catch {
				// already closed
			}
			resolve({
				text: "",
				sessionID: null,
				tokens: zeroTokens(),
				costUsd: 0,
				sawError: true,
				errorMsg: `spawn failed: ${(err as Error).message}`,
				tools: 0,
				models: 0,
				skills: 0,
				breakdown: {},
			});
			return;
		}
		let startOffset: number;
		try {
			startOffset = fstatSync(fdOut).size;
		} catch (err) {
			try {
				closeSync(fdOut);
			} catch {
				// already closed
			}
			try {
				closeSync(fdErr);
			} catch {
				// already closed
			}
			resolve({
				text: "",
				sessionID: null,
				tokens: zeroTokens(),
				costUsd: 0,
				sawError: true,
				errorMsg: `spawn failed: ${(err as Error).message}`,
				tools: 0,
				models: 0,
				skills: 0,
				breakdown: {},
			});
			return;
		}

		// WORKER_TIMEOUT_MS kill switch: SIGTERM the worker after the timeout,
		// then SIGKILL after an optional grace period (WORKER_TIMEOUT_GRACE_MS).
		const timeoutMs = Number(process.env.WORKER_TIMEOUT_MS ?? "") || 0;
		const graceMs = Number(process.env.WORKER_TIMEOUT_GRACE_MS ?? "") || 1000;
		let timedOut = false;
		let killTimer: NodeJS.Timeout | undefined;
		let graceTimer: NodeJS.Timeout | undefined;

		let settled = false;
		let stopTail = () => {};
		const settle = (s: ParsedStream) => {
			if (settled) return;
			settled = true;
			clearTimeout(killTimer);
			clearTimeout(graceTimer);
			stopTail();
			if (fdOut !== undefined) {
				try {
					closeSync(fdOut);
				} catch {
					// already closed
				}
			}
			if (fdErr !== undefined) {
				try {
					closeSync(fdErr);
				} catch {
					// already closed
				}
			}
			resolve(s);
		};

		try {
			const child = forkWorker({
				entry: workerEntry(),
				env: {
					...process.env,
					SOR_PROVIDER: provider,
					SOR_EVENT_DIR: eventsDir,
					// Pin the fleet to this one candidate so the worker's own
					// resolveProviderModel lands on exactly the walked provider.
					FLEET_PROVIDERS: provider,
					// Policy snapshot: has no effect in `compatibility` (empty),
					// injected as `SOR_POLICY_MODE/HASH/VERSION/JSON_B64` otherwise.
					...policyEnv,
				},
				fdOut,
				fdErr,
			});
			if (quota) {
				child.on("message", (message: unknown) => {
					if (!message || typeof message !== "object") return;
					const m = message as Record<string, unknown>;
					if (
						m.type !== "quota_reserve" ||
						typeof m.requestId !== "string" ||
						typeof m.model !== "string" ||
						m.managerId !== MANAGER_ID ||
						m.runId !== ctx.runId ||
						m.workerId !== workerId ||
						m.role !== role ||
						typeof m.sessionId !== "string" ||
						typeof m.attempt !== "number" ||
						!Number.isInteger(m.attempt) ||
						m.attempt < 1 ||
						(workerSessionId !== undefined &&
							m.sessionId !== workerSessionId) ||
						(modelOverride !== undefined && m.model !== modelOverride)
					) {
						if (m.type === "quota_reserve" && typeof m.requestId === "string") {
							try {
								child.send({
									type: "quota_reserve_result",
									requestId: m.requestId,
									result: { ok: false, error: "reservation identity rejected" },
								});
							} catch {
								// The worker will fail closed when the IPC channel is gone.
							}
						}
						return;
					}
					workerSessionId ??= m.sessionId as string;
					const result = quota.checkAndReserve({
						provider: "gemini",
						model: m.model,
						estimatedInputTokens:
							typeof m.estimatedInputTokens === "number"
								? m.estimatedInputTokens
								: -1,
						maximumOutputTokens:
							typeof m.maximumOutputTokens === "number"
								? m.maximumOutputTokens
								: -1,
					});
					if (
						!result.ok &&
						result.waitMs !== undefined &&
						result.waitMs > geminiRateLimitWaitMs()
					) {
						result.waitMs = 0;
						result.error = "GEMINI_RATE_LIMIT_WAIT_CEILING";
					}
					try {
						child.send({
							type: "quota_reserve_result",
							requestId: m.requestId,
							reservationId: result.reservationId,
							result,
						});
					} catch {
						// The worker will fail closed when the IPC channel is gone.
					}
					if (result.terminal)
						opts.onEvent?.({
							t: "quota_exhausted",
							model: m.model,
							resetAt: result.resetAt,
							state: "quota_exhausted",
						});
				});
			}
			liveChildren.add(child);
			child.on("close", () => liveChildren.delete(child));
			child.on("error", () => liveChildren.delete(child));
			stopTail = startTailing(
				tracePath,
				startOffset,
				opts.onText,
				opts.onEvent,
			);

			const job = {
				role,
				task,
				ctx: {
					rootDir: ctx.rootDir,
					worktreeDir: ctx.worktreeDir,
					tracesDir: ctx.tracesDir,
					runDir: ctx.runDir,
					dryRun: ctx.dryRun,
					managerId: MANAGER_ID,
					runId: ctx.runId,
					workerId,
					...(extraTask !== undefined ? { extraTask } : {}),
					maxOutputTokens: Number(process.env.GEMINI_MAX_OUTPUT_TOKENS ?? 8192),
					...(modelOverride !== undefined ? { model: modelOverride } : {}),
					...(resumeFromPath !== undefined
						? { resumeFrom: { messagesPath: resumeFromPath } }
						: {}),
				},
			};
			if (child.stdin) {
				child.stdin.on("error", () => {}); // EPIPE when the child dies before reading the job
				child.stdin.end(`${JSON.stringify(job)}\n`);
			}

			child.on("error", (err) => {
				settle({
					text: "",
					sessionID: null,
					tokens: zeroTokens(),
					costUsd: 0,
					sawError: true,
					errorMsg: `spawn failed: ${err.message}`,
					tools: 0,
					models: 0,
					skills: 0,
					breakdown: {},
				});
			});

			if (timeoutMs > 0) {
				killTimer = setTimeout(() => {
					timedOut = true;
					child.kill("SIGTERM");
					graceTimer = setTimeout(() => {
						try {
							child.kill("SIGKILL");
						} catch {
							// already dead
						}
					}, graceMs);
				}, timeoutMs);
			}

			child.on("close", (code) => {
				const parsed = parseTrace(tracePath, opts, startOffset, provider);
				if (timedOut) {
					parsed.sawError = true;
					parsed.errorMsg = `timed out after ${timeoutMs}ms${parsed.errorMsg ? `: ${parsed.errorMsg}` : ""}`;
				} else if (abortRequested) {
					parsed.sawError = true;
					parsed.errorMsg = "aborted by user";
				} else if (code !== 0 && !parsed.sawError) {
					parsed.sawError = true;
					parsed.errorMsg = `exit ${code}: ${readStderrTail(stderrPath)}`;
				}
				settle(parsed);
			});
		} catch (err) {
			settle({
				text: "",
				sessionID: null,
				tokens: zeroTokens(),
				costUsd: 0,
				sawError: true,
				errorMsg: `spawn failed: ${(err as Error).message}`,
				tools: 0,
				models: 0,
				skills: 0,
				breakdown: {},
			});
		}
	});
}

/** Read back this attempt's trace from the trace file and build the parsed shape for `provider`. */
export function parseTrace(
	tracePath: string,
	opts: RunWorkerOpts,
	startOffset: number,
	provider: ProviderName = "gemini",
): ParsedStream {
	void opts;
	let raw: string;
	try {
		raw = readFileSync(tracePath, "utf8");
	} catch {
		return {
			text: "",
			sessionID: null,
			tokens: zeroTokens(),
			costUsd: 0,
			sawError: false,
			tools: 0,
			models: 0,
			skills: 0,
			breakdown: {},
		};
	}
	const t = parseProviderTrace(provider, raw, startOffset);
	return {
		text: t.text,
		sessionID: t.sessionID,
		model: t.model ?? undefined,
		tokens: t.tokens,
		costUsd: t.costUsd,
		sawError: t.sawError,
		errorMsg: t.errorMsg,
		lastBashExitCode: t.lastBashExitCode,
		bashCommands: t.bashCommands,
		tools: t.tools,
		models: t.models,
		skills: t.skills,
		breakdown: t.breakdown,
	};
}

/** Last 400 chars of the per-attempt stderr log file, trimmed. */
export function readStderrTail(stderrPath: string): string {
	try {
		return readFileSync(stderrPath, "utf8").slice(-400).trim();
	} catch {
		return "";
	}
}

export function finalize(
	role: Role,
	model: string,
	s: ParsedStream,
	tracePath: string,
	startedAt: number,
	ok: boolean,
	error?: string,
	attempts?: NonNullable<AgentResult["attempts"]>,
	provider: ProviderName = "gemini",
): AgentResult {
	return {
		role,
		ok,
		sessionID: s.sessionID,
		model,
		provider,
		attempts,
		text: s.text,
		tokens: s.tokens,
		costUsd: s.costUsd,
		sawError: s.sawError,
		lastBashExitCode: s.lastBashExitCode,
		bashCommands: s.bashCommands,
		calls: {
			tools: s.tools,
			models: s.models,
			skills: s.skills,
			breakdown: s.breakdown,
		},
		error,
		tracePath,
		startedAt,
		endedAt: Date.now(),
	};
}

export function stubResult(
	role: Role,
	model: string,
	tracePath: string,
	startedAt: number,
	provider: ProviderName = "gemini",
): AgentResult {
	return {
		role,
		ok: true,
		sessionID: `dry-${role}`,
		model,
		provider,
		attempts: [{ model, ok: true, provider }],
		text: `[dry-run] ${role} would run here.`,
		tokens: zeroTokens(),
		costUsd: 0,
		sawError: false,
		tracePath,
		startedAt,
		endedAt: Date.now(),
	};
}

export const zeroTokens = (): AgentResult["tokens"] => ({
	input: 0,
	output: 0,
	reasoning: 0,
	cached: 0,
	cacheWrite: 0,
	total: 0,
});
export const emptyStream = (): ParsedStream => ({
	text: "",
	sessionID: null,
	tokens: zeroTokens(),
	costUsd: 0,
	sawError: true,
	tools: 0,
	models: 0,
	skills: 0,
	breakdown: {},
});

/**
 * Bridge worker stream events into `opts.onEvent` so runtimes share one
 * forwarding path. The ctx/role/provider args keep the call site self-describing.
 */
export function makeEventBridge(
	ctx: RunContext,
	role: Role,
	provider: ProviderName,
	opts: RunWorkerOpts | undefined,
): (ev: Record<string, unknown>) => void {
	void ctx;
	void role;
	void provider;
	return (ev) => opts?.onEvent?.(ev);
}

/**
 * Fire-and-forget `wakeup` SOR write from a worker spawn. Non-fatal by
 * contract: any failure logs a warning and never aborts the run. No-op in
 * dry-run mode.
 */
export function emitWakeup(
	ctx: RunContext,
	provider: ProviderName,
	payload: Record<string, unknown>,
): Promise<void> {
	if (ctx.dryRun) return Promise.resolve();
	void (async () => {
		try {
			await ensureChain(pool);
			await appendAuditEvent(pool, {
				run_id: null,
				event_type: "wakeup",
				actor: "manager",
				backend: provider,
				tool_name: null,
				tool_input: null,
				tool_output: null,
				payload,
				created_at: new Date().toISOString(),
			});
		} catch (err) {
			console.warn(
				`[sor] wakeup skipped: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	})();
	return Promise.resolve();
}

/**
 * Live-tails the per-attempt trace file while the worker is running so `opts.onText`
 * fires in real time (the file-redirect stdio stays untouched). A no-op when no
 * `onText` hook is provided. Returns a stop function that also flushes a final
 * complete line (handles a trailing newline-less JSON event at exit).
 *
 * Uses a single open file descriptor read from a tracked byte offset, so each
 * poll only fetches the bytes written since the last poll instead of rereading
 * the whole file.
 */
function startTailing(
	tracePath: string,
	startOffset: number,
	onText: ((chunk: string) => void) | undefined,
	onEvent: ((ev: Record<string, unknown>) => void) | undefined,
): () => void {
	if (!onText && !onEvent) return () => {};
	let fd: number | undefined;
	try {
		fd = openSync(tracePath, "r");
	} catch {
		// trace file not present yet; nothing to tail
		return () => {};
	}
	let offset = startOffset;
	let pending = "";
	const emit = (line: string): void => {
		if (!line.trim()) return;
		let ev: Record<string, unknown>;
		try {
			ev = JSON.parse(line) as Record<string, unknown>;
		} catch {
			return; // partial or non-JSON noise
		}
		onEvent?.(ev);
		const part = (ev.part ?? {}) as { text?: unknown };
		if (ev.t === "text" && typeof part.text === "string") onText?.(part.text);
	};
	const step = (): void => {
		let size: number;
		if (fd === undefined) return;
		try {
			size = fstatSync(fd).size;
		} catch {
			return; // fd closed or file gone
		}
		if (size <= offset) return;
		const length = size - offset;
		const buf = Buffer.allocUnsafe(length);
		let got = 0;
		try {
			got = readSync(fd, buf, 0, length, offset);
		} catch {
			return;
		}
		if (got === 0) return;
		const chunk = pending + buf.subarray(0, got).toString("utf8");
		offset += got;
		const nl = chunk.lastIndexOf("\n");
		if (nl === -1) {
			pending = chunk;
			return;
		}
		const complete = chunk.slice(0, nl);
		pending = chunk.slice(nl + 1);
		for (const line of complete.split("\n")) emit(line);
	};
	const timer = setInterval(step, 150);
	return () => {
		clearInterval(timer);
		step();
		if (pending) {
			emit(pending);
			pending = "";
		}
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// already closed
			}
		}
	};
}

export function aggregateAgentResults(results: AgentResult[]): AgentResult {
	const first = results[0];
	if (!first) {
		throw new Error("aggregateAgentResults: no results to aggregate");
	}
	const last = results[results.length - 1] as AgentResult;
	const tokens: AgentResult["tokens"] = {
		input: 0,
		output: 0,
		reasoning: 0,
		cached: 0,
		cacheWrite: 0,
		total: 0,
	};
	let costUsd = 0;
	const attempts: NonNullable<AgentResult["attempts"]> = [];
	const text: string[] = [];
	let error: string | undefined;
	let callsTools = 0;
	let callsModels = 0;
	let callsSkills = 0;
	const callsBreakdown: Record<string, number> = {};
	for (const r of results) {
		tokens.input += r.tokens.input;
		tokens.output += r.tokens.output;
		tokens.reasoning += r.tokens.reasoning;
		tokens.cached += r.tokens.cached;
		tokens.cacheWrite += r.tokens.cacheWrite;
		tokens.total += r.tokens.total;
		costUsd += r.costUsd ?? 0;
		if (r.attempts) attempts.push(...r.attempts);
		if (r.text.trim()) text.push(r.text);
		if (!error && r.error) error = r.error;
		callsTools += r.calls?.tools ?? 0;
		callsModels += r.calls?.models ?? 0;
		callsSkills += r.calls?.skills ?? 0;
		const bd = r.calls?.breakdown ?? {};
		for (const [k, v] of Object.entries(bd))
			callsBreakdown[k] = (callsBreakdown[k] ?? 0) + v;
	}
	return {
		role: first.role,
		ok: results.every((r) => r.ok),
		sessionID: last.sessionID,
		model: last.model,
		provider: last.provider, // Preserve provider from last result
		attempts,
		text: text.join("\n"),
		tokens,
		costUsd,
		sawError: results.some((r) => r.sawError ?? false),
		calls: {
			tools: callsTools,
			models: callsModels,
			skills: callsSkills,
			breakdown: callsBreakdown,
		},
		error,
		tracePath: first.tracePath,
		startedAt: first.startedAt,
		endedAt: last.endedAt,
	};
}

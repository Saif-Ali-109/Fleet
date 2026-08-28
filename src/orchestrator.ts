import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	requestQuotaResume,
	resetGeminiQuotaCoordinator,
	runWorker,
} from "./agentRunner.ts";
import { appendAuditEvent, ensureChain } from "./db/audit.ts";
import { db, pool } from "./db/client.ts";
import { upsertAgentCallStats } from "./db/queries/callStats.ts";
import {
	PauseManager,
	reloadApiKeyEnv,
	resumeFromPause,
	setActiveResumeHandler,
} from "./fleet/pauseManager.ts";
import { onQuotaEvent, type QuotaEvent } from "./fleet/quotaEvents.ts";
import {
	assertGeminiModelChainConfiguration,
	assertGeminiQuotaConfiguration,
	geminiQuotaConfig,
	geminiRateLimitWaitMs,
} from "./gemini/quotaConfig.ts";
import { buildSkeletonMap } from "./git/snapshotReader.ts";
import type { WorktreeHandle } from "./git/worktree.ts";
import { setupWorktree } from "./git/worktree.ts";
import { logLine, resetSessionLog } from "./memory/sessionLog.ts";
import { invalidateProviderClients } from "./providers/registry.ts";
import type { SorEvent } from "./sor/events.ts";
import type { DashboardState } from "./tui/dashboard.ts";
import { newDashboardState, renderDashboard } from "./tui/dashboard.ts";
import type {
	AgentResult,
	ProviderName,
	Role,
	RolePolicy,
	RunContext,
} from "./types.ts";
import { commitMessageFor } from "./utils/commitMessage.ts";
import { collapseConsecutiveModels } from "./utils/models.ts";
import { finalizeRun } from "./workflow/finalize.ts";
import { makeOnEvent } from "./workflow/makeOnEvent.ts";
import { runAnalyzePhase } from "./workflow/phases/analyze.ts";
import { runDonePhase } from "./workflow/phases/done.ts";
import { runImplementPhase } from "./workflow/phases/implement.ts";
import { runPlanPhase } from "./workflow/phases/plan.ts";
import { runPrPhase } from "./workflow/phases/pr.ts";
import { ScoutTracker } from "./workflow/scoutTracker.ts";

export { collapseConsecutiveModels, commitMessageFor };

export type RunStatus = "completed" | "aborted" | "failed";

const CONTRIBUTING_MAX_CHARS = 4000;

/** Commit-convention guidance for coder/pr prompts: the repo's CONTRIBUTING.md when present, else a default. */
export async function readContributionGuidance(
	worktreeDir: string,
): Promise<string> {
	try {
		const raw = await readFile(join(worktreeDir, "CONTRIBUTING.md"), "utf8");
		return [
			"## Contribution conventions",
			"The target repository defines contribution conventions. Follow them exactly for commit messages, PR title, and PR description:",
			"",
			raw.slice(0, CONTRIBUTING_MAX_CHARS),
		].join("\n");
	} catch {
		return '## Commit conventions\nUse conventional commit style (e.g. "fix: ...") for all commit messages.';
	}
}

/** Live web-mirror hooks; the web dashboard pushes these on every TUI render/text chunk. */
export interface WebFeed {
	pushState(d: DashboardState): void;
	pushOutput(role: Role, text: string): void;
	pushAgentEvent?(role: Role, event: Record<string, unknown>): void;
	pushNotice?(msg: string): void;
	pushFinal?(phase: DashboardState["phase"], prUrl?: string): void;
	pushQuotaEvent?(event: QuotaEvent): void;
	/** Toggle the persistent quota-pause banner (SPEC §11.5 PAUSED state). */
	pushPause?(paused: boolean, message?: string): void;
}

export interface RunSummary {
	runId: string;
	repo: string;
	issue: number;
	status: RunStatus;
	prUrl?: string;
	failure?: string;
	backend: ProviderName;
	agents: Record<Role, AgentResult>;
	totalCostUsd: number;
	calls: { tools: number; models: number; skills: number };
	iterationsUsed: number;
	startedAt: number;
	endedAt: number;
}

const ROLES: Role[] = [
	"analyzer",
	"planner",
	"coder",
	"tester",
	"reviewer",
	"pr",
];
type Phase = DashboardState["phase"];

export { reloadApiKeyEnv, resumeFromPause };

/**
 * Non-fatal append of one signed audit event to the System of Record.
 * Builds a full SorEvent from `event` overrides (defaulting event_type to
 * "phase", actor to "manager", backend to the run's backend), with run_id from
 * `ctx` and created_at = now. Every error is swallowed with a warning so a
 * missing DB or SOR_SIGNING_KEY never aborts a real run. Phase/finalize events
 * are recorded even for dry-run runs (workers are stubbed there, so no tool
 * calls, but the lifecycle must still chain) — only the hook-file drain and
 * spawn/tool events are dry-run-agnostic by nature.
 */
async function sorEmit(
	ctx: RunContext | { runId: string; dryRun?: boolean },
	event: Partial<SorEvent>,
): Promise<void> {
	const backend = "provider" in ctx ? ctx.provider : undefined;
	const sorEvent: SorEvent = {
		run_id: ctx.runId,
		event_type: event.event_type ?? "phase",
		actor: event.actor ?? "manager",
		backend: event.backend ?? backend ?? null,
		tool_name: event.tool_name ?? null,
		tool_input: event.tool_input ?? null,
		tool_output: event.tool_output ?? null,
		payload: event.payload ?? {},
		created_at: new Date().toISOString(),
	};
	try {
		await appendAuditEvent(pool, sorEvent);
	} catch (e) {
		console.warn(`[sor] appendAuditEvent failed (non-fatal): ${String(e)}`);
	}
}

// The Manager (not an LLM): issue intake → 6 workers (no human gates) → PR.
export async function runOrchestrator(
	ctx: RunContext,
	opts: { web?: WebFeed },
): Promise<RunSummary> {
	const startedAt = Date.now();
	const web = opts.web;
	const dash = newDashboardState(
		ctx.runId,
		ctx.issue.repo,
		ctx.issue.number,
		ctx.provider ?? "gemini",
	);
	const agents = {} as Record<Role, AgentResult>;
	const scoutTracker = new ScoutTracker();
	let runId: string | undefined;
	let prUrl: string | undefined;
	let iterationsUsed = 0;
	// Set once the worktree is up (or the dry-run stub replaces it); every
	// finalize() branch tears it down so we never leak linked worktrees.
	let wt: WorktreeHandle | undefined;

	const render = () => process.stdout.write(`${renderDashboard(dash)}\n`);
	const pushState = () => {
		let tools = 0;
		let models = 0;
		let skills = 0;
		let costUsd = 0;
		let tokens = 0;
		for (const role of ROLES) {
			const a = dash.agents[role];
			if (!a) continue;
			tools += a.calls?.tools ?? 0;
			models += a.calls?.models ?? 0;
			skills += a.calls?.skills ?? 0;
			costUsd += a.costUsd ?? 0;
			tokens += a.tokens?.total ?? 0;
		}
		dash.totals = { tools, models, skills, costUsd, tokens };
		render();
		web?.pushState(dash);
	};
	// Throttled variant for hot event paths: rapid tool/telemetry events must
	// not spam SSE broadcasts or TUI renders; the next full push happens at
	// agent completion regardless.
	let lastPushAt = 0;
	const pushStateThrottled = () => {
		const now = Date.now();
		if (now - lastPushAt < 500) return;
		lastPushAt = now;
		pushState();
	};
	const setPhase = (phase: Phase | "failed") => {
		(dash as { phase: string }).phase = phase;
	};
	const pm = new PauseManager(setPhase, pushState);
	const totalCostUsd = (): number => {
		let sum = 0;
		for (const role of ROLES) {
			const a = agents[role];
			if (a) sum += a.costUsd ?? 0;
		}
		return sum;
	};
	const totalCalls = (): { tools: number; models: number; skills: number } => {
		return Object.values(agents).reduce(
			(acc, a) => ({
				tools: acc.tools + (a.calls?.tools ?? 0),
				models: acc.models + (a.calls?.models ?? 0),
				skills: acc.skills + (a.calls?.skills ?? 0),
			}),
			{ tools: 0, models: 0, skills: 0 },
		);
	};
	const makeSummary = (status: RunStatus, failure?: string): RunSummary => {
		return {
			runId: ctx.runId,
			repo: ctx.issue.repo,
			issue: ctx.issue.number,
			status,
			prUrl,
			failure,
			backend: ctx.provider ?? "gemini",
			agents,
			totalCostUsd: totalCostUsd(),
			calls: totalCalls(),
			iterationsUsed,
			startedAt,
			endedAt: Date.now(),
		};
	};
	/** Persist result.json for terminal runs; failures get the same blob as the success path (incl. attempts + failure). */
	const writeResultFile = async (summary: RunSummary): Promise<void> => {
		try {
			await mkdir(ctx.runDir, { recursive: true });
			await writeFile(
				join(ctx.runDir, "result.json"),
				`${JSON.stringify(summary, null, 2)}\n`,
			);
		} catch (e) {
			console.warn(
				`[result] result.json write skipped (non-fatal): ${String(e)}`,
			);
		}
	};
	// Boot gate (fail fast on real runs; dry-run stays keyless/green): the
	// per-role Gemini model chain must be fully configured before any spawn.
	if (!ctx.dryRun && (ctx.provider ?? "gemini") === "gemini") {
		try {
			geminiRateLimitWaitMs();
			assertGeminiQuotaConfiguration(ROLES, geminiQuotaConfig());
			assertGeminiModelChainConfiguration(ROLES, geminiQuotaConfig());
		} catch (e) {
			const failure = e instanceof Error ? e.message : String(e);
			setPhase("failed");
			return makeSummary("failed", failure);
		}
	}
	const finalize = async (
		status: string,
		gateStatus: Record<string, unknown>,
		reason?: string,
	): Promise<void> => {
		await finalizeRun({
			status,
			gateStatus,
			failureReason: reason ?? null,
			prUrl: prUrl ?? null,
			totalCostUsd: () => totalCostUsd(),
			runId: runId ?? null,
			ctx,
			teardownPause: () => pm.teardownPause(web),
			sorEmit,
			writeResultFile: async (s, r) => {
				const outerWrite = writeResultFile;
				await outerWrite(makeSummary(s as RunStatus, r ?? undefined));
			},
			wt,
		});
	};

	const runAgent = async (
		role: Role,
		phase: Phase,
		task: string,
		policy: RolePolicy,
	): Promise<AgentResult> => {
		setPhase(phase);
		dash.agents[role] = { role, state: "running", model: policy.model };
		pushState();
		const onText = (t: string) => web?.pushOutput(role, t);
		const onEvent = makeOnEvent({
			role,
			ctx,
			sorEmitFn: sorEmit,
			scoutTracker,
			pushStateThrottled,
			pushAgentEvent: (r, ev) => web?.pushAgentEvent?.(r, ev),
			pushNotice: web?.pushNotice?.bind(web),
			policyModel: policy.model,
			dash,
			emitSor: true,
		});
		const res = await runWorker(role, task, ctx, policy, { onText, onEvent });
		agents[role] = res;
		dash.agents[role] = {
			role,
			state: res.ok ? "done" : "failed",
			model: res.model,
			sessionID: res.sessionID ?? undefined,
			tokens: res.tokens,
			costUsd: res.costUsd,
			calls: res.calls,
			startedAt: res.startedAt,
			endedAt: res.endedAt,
			error: res.error,
		};
		pushState();
		if (runId) {
			await db.logAgentAction({
				run_id: runId,
				role,
				model: res.model,
				ok: res.ok,
				text: res.text,
				tokens: res.tokens,
				cost_usd: res.costUsd ?? 0,
				trace_path: res.tracePath,
				started_at: new Date(res.startedAt),
				ended_at: new Date(res.endedAt),
				attempts: res.attempts ?? [],
			});
			try {
				await upsertAgentCallStats(pool, runId, {
					role,
					model: res.model,
					provider: null,
					sessionId: res.sessionID ?? null,
					toolCalls: res.calls?.tools ?? 0,
					modelCalls: res.calls?.models ?? 0,
					skillLoads: res.calls?.skills ?? 0,
					toolBreakdown: res.calls?.breakdown ?? {},
				});
			} catch {
				/* non-fatal */
			}
		}
		if (res.attempts) {
			const collapsed = collapseConsecutiveModels(
				res.attempts.map((a) => a.model),
			);
			if (collapsed.length > 1) {
				await logLine(
					ctx.rootDir,
					`[${role}] fell back across ${collapsed.length} models: ${collapsed.join(" -> ")}`,
				);
			}
		}
		await logLine(
			ctx.rootDir,
			`${role} ${res.ok ? "done" : "failed"}${res.error ? `: ${res.error}` : ""}`,
		);
		return res;
	};

	// User-facing quota notifications ("everywhere"): console + SESSION_LOG +
	// non-fatal SOR + TUI/web live state. all-models-RPD-dead NEVER kills the
	// run: it flips the run into phase "paused" (persistent banner + browser
	// Notification + console reminder every ~5 min) until a key-change Resume.
	// Unsubscribed in the outer finally so no listener leaks across runs.
	const unsubscribeQuota = onQuotaEvent((ev: QuotaEvent): void => {
		if (ev.type === "model_switch") {
			const wait =
				ev.waitMs > 0 ? ` (wait ~${Math.round(ev.waitMs / 1000)}s)` : "";
			const msg = `[quota] ${ev.role}: ${ev.fromModel} rate limited (${ev.block}) → switching to ${ev.toModel}${wait}`;
			console.warn(msg);
			void logLine(ctx.rootDir, msg);
			dash.quotaNotice = `${ev.role}: ${ev.fromModel} rate limited (${ev.block}) → ${ev.toModel}`;
			pushStateThrottled();
			web?.pushQuotaEvent?.(ev);
			void sorEmit(ctx, {
				event_type: "model_switch",
				actor: ev.role,
				backend: "gemini",
				payload: {
					role: ev.role,
					provider: ev.provider,
					from_model: ev.fromModel,
					to_model: ev.toModel,
					block: ev.block,
					wait_ms: ev.waitMs,
				},
			});
			return;
		}
		if (ev.type === "model_recovered") {
			const msg = `[quota] ${ev.role}: ${ev.model} available again → switching back`;
			console.log(msg);
			void logLine(ctx.rootDir, msg);
			dash.quotaNotice = `${ev.role}: ${ev.model} available again → switching back`;
			pushStateThrottled();
			web?.pushQuotaEvent?.(ev);
			void sorEmit(ctx, {
				event_type: "model_recovered",
				actor: ev.role,
				backend: "gemini",
				payload: { role: ev.role, provider: ev.provider, model: ev.model },
			});
			return;
		}
		if (!pm.enterPause(ev.role, dash.phase)) return;
		const msg = `[quota] all Gemini models RPD exhausted for ${ev.role} — run paused; change your API key, then Resume`;
		console.error(msg);
		void logLine(ctx.rootDir, msg);
		void logLine(
			ctx.rootDir,
			`[quota] run paused — completed roles stay completed, pipeline position preserved`,
		);
		dash.quotaNotice = `all Gemini models RPD exhausted for ${ev.role} — change your API key, then Resume`;
		setPhase("paused");
		pushState();
		web?.pushQuotaEvent?.(ev);
		web?.pushPause?.(true, pm.getBannerText());
		web?.pushNotice?.(pm.getBannerText());
		void sorEmit(ctx, {
			event_type: "all_models_exhausted",
			actor: "manager",
			backend: "gemini",
			payload: { role: ev.role, provider: ev.provider, models: ev.models },
		});
		void sorEmit(ctx, {
			event_type: "run_paused",
			actor: "manager",
			backend: "gemini",
			payload: { role: ev.role, provider: ev.provider, models: ev.models },
		});
		pm.startReminder();
	});

	// Registered for the lifetime of the run so index.ts can route a dashboard
	// resume click here via resumeFromPause() (SPEC §11.5 resume steps a-c).
	setActiveResumeHandler((): boolean => {
		if (!pm.isPaused()) return false;
		const role = pm.getPausedRole();
		if (!role) return false;
		const keysReloaded = reloadApiKeyEnv(ctx.rootDir);
		if (keysReloaded.length > 0) {
			void logLine(
				ctx.rootDir,
				`[quota] resume: reloaded ${keysReloaded.join(", ")} from .env`,
			);
		}
		invalidateProviderClients();
		try {
			resetGeminiQuotaCoordinator();
		} catch (e) {
			console.warn(
				`[quota] coordinator reset failed (non-fatal): ${String(e)}`,
			);
		}
		pm.exitPause(web);
		const delivered = requestQuotaResume();
		void logLine(
			ctx.rootDir,
			`[quota] run resumed${delivered ? "" : " (no parked worker walk)"} — restarting ${role} from its checkpoint`,
		);
		void sorEmit(ctx, {
			event_type: "run_resumed",
			actor: "manager",
			backend: "gemini",
			payload: { role, provider: "gemini", keys_reloaded: keysReloaded },
		});
		return delivered;
	});

	try {
		try {
			await ensureChain(pool);
		} catch (e) {
			console.warn(`[sor] ensureChain failed (non-fatal): ${String(e)}`);
		}
		await resetSessionLog(ctx.rootDir, ctx.runDir, ctx.runId, {
			repo: ctx.issue.repo,
			issue: ctx.issue.number,
			title: ctx.issue.title,
		});
		await logLine(ctx.rootDir, "run started");
		if (!ctx.dryRun) {
			runId = await db.createRun({
				repo: ctx.issue.repo,
				issue_number: ctx.issue.number,
				backend: ctx.provider ?? "gemini",
			});
			await db.updateRunStatus({
				run_id: runId,
				phase: "start",
				status: "running",
				iteration: 0,
			});
		}
		await sorEmit(ctx, {
			event_type: "phase",
			actor: "manager",
			payload: { phase: "start", status: "running", iteration: 0 },
		});

		if (ctx.dryRun) {
			await mkdir(ctx.runDir, { recursive: true });
			await mkdir(ctx.worktreeDir, { recursive: true });
			wt = {
				repoDir: join(ctx.runDir, "repo"),
				worktreeDir: ctx.worktreeDir,
				branch: ctx.branch,
				baseBranch: "main",
			};
		} else {
			wt = await setupWorktree(
				ctx.repoUrl,
				ctx.runDir,
				ctx.branch,
				ctx.cloneDir,
			);
			await logLine(
				ctx.rootDir,
				`worktree ready at ${wt.worktreeDir} base ${wt.baseBranch}`,
			);
		}

		const skeleton = await buildSkeletonMap(ctx.worktreeDir);

		const analyzeResult = await runAnalyzePhase({
			ctx,
			runAgent,
			setPhase,
			pushState,
			finalize,
			makeSummary,
			runId,
			sorEmit,
		});
		if (!analyzeResult.ok) return analyzeResult.summary;
		const { fixSpec } = analyzeResult;

		const planResult = await runPlanPhase({
			ctx,
			fixSpec,
			runAgent,
			setPhase,
			pushState,
			finalize,
			makeSummary,
			runId,
			sorEmit,
			skeleton,
		});
		if (!planResult.ok) return planResult.summary;
		const { plan, commitMessage, planMd, route } = planResult;

		const implResult = await runImplementPhase({
			ctx,
			plan,
			planMd,
			commitMessage,
			route,
			wt,
			runId,
			dash,
			agents,
			scoutTracker,
			web,
			setPhase,
			pushState,
			pushStateThrottled,
			finalize,
			makeSummary,
			sorEmit,
		});
		if (!implResult.ok) return implResult.summary;
		iterationsUsed = implResult.iterationsUsed;

		const prResult = await runPrPhase({
			ctx,
			wt,
			runAgent,
			setPhase,
			pushState,
			finalize,
			makeSummary,
			agents,
		});
		if (!prResult.ok) return prResult.summary;
		prUrl = prResult.prUrl;

		return await runDonePhase({
			ctx,
			runId,
			prUrl,
			agents,
			scoutTracker,
			dash,
			web,
			setPhase,
			pushState,
			finalize,
			makeSummary,
			writeResultFile,
			sorEmit,
			iterationsUsed,
		});
	} catch (e) {
		await logLine(ctx.rootDir, `orchestrator error: ${String(e)}`);
		setPhase("failed");
		pushState();
		await finalize("failed", {}, String(e));
		return makeSummary("failed", String(e));
	} finally {
		unsubscribeQuota();
		setActiveResumeHandler(null);
	}
}

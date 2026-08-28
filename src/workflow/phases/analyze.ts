import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { db } from "../../db/client.ts";
import { policyFor } from "../../models/modelPolicy.ts";
import type { RunStatus, RunSummary } from "../../orchestrator.ts";
import type { SorEvent } from "../../sor/events.ts";
import type { DashboardState } from "../../tui/dashboard.ts";
import type {
	AgentResult,
	FixSpec,
	Role,
	RolePolicy,
	RunContext,
} from "../../types.ts";
import { extractJson } from "../../utils/json.ts";

type Phase = DashboardState["phase"];

export interface AnalyzePhaseOpts {
	ctx: RunContext;
	runAgent: (
		role: Role,
		phase: Phase,
		task: string,
		policy: RolePolicy,
	) => Promise<AgentResult>;
	setPhase: (phase: Phase | "failed") => void;
	pushState: () => void;
	finalize: (
		status: string,
		gateStatus: Record<string, unknown>,
		reason?: string,
	) => Promise<void>;
	makeSummary: (status: RunStatus, failure?: string) => RunSummary;
	runId: string | undefined;
	sorEmit: (
		ctx: RunContext | { runId: string; dryRun?: boolean },
		event: Partial<SorEvent>,
	) => Promise<void>;
}

export type AnalyzePhaseResult =
	| { ok: true; fixSpec: FixSpec }
	| { ok: false; summary: RunSummary };

export async function runAnalyzePhase(
	opts: AnalyzePhaseOpts,
): Promise<AnalyzePhaseResult> {
	const {
		ctx,
		runAgent,
		setPhase,
		pushState,
		finalize,
		makeSummary,
		runId,
		sorEmit,
	} = opts;

	const analyzerTask = [
		`Issue #${ctx.issue.number}: ${ctx.issue.title}`,
		"",
		ctx.issue.body,
		"",
		"## Skeleton",
		"File paths and symbol headers are provided separately (JIT).",
		"Do not use read/grep/glob tools; rely on the provided structure.",
		"If you need a specific file's full content, it will be provided JIT (just-in-time) after planning.",
		"",
		`Return ONLY one JSON object with exactly this shape and nothing else:`,
		`{"summary": "...", "rootCause": "...", "suspectFiles": ["..."], "affectedSymbols": ["..."], "reproduction": "...", "testStrategy": "...", "risks": ["..."], "confidence": "low" | "medium" | "high"}`,
	].join("\n");
	const a = await runAgent(
		"analyzer",
		"analyze",
		analyzerTask,
		policyFor("analyzer", ctx.provider ?? "gemini"),
	);
	if (!a.ok) {
		setPhase("failed");
		pushState();
		await finalize("failed", {}, a.error ?? "analyzer failed");
		return {
			ok: false,
			summary: makeSummary("failed", a.error ?? "analyzer failed"),
		};
	}
	if (runId) {
		await db.updateRunStatus({
			run_id: runId,
			phase: "analyze",
			status: "completed",
			iteration: 0,
		});
	}
	await sorEmit(ctx, {
		event_type: "phase",
		actor: "manager",
		payload: { phase: "analyze", status: "completed", iteration: 0 },
	});

	let fixSpec: FixSpec | null = null;
	if (ctx.dryRun) {
		fixSpec = {
			summary: "[dry-run] analyzer findings",
			rootCause: "[dry-run]",
			suspectFiles: [],
			affectedSymbols: [],
			reproduction: "[dry-run]",
			testStrategy: "[dry-run]",
			risks: [],
			confidence: "low",
		};
	} else {
		fixSpec = extractJson<FixSpec>(a.text);
	}
	if (!fixSpec) {
		setPhase("failed");
		pushState();
		await finalize(
			"failed",
			{},
			"analyzer did not return a valid FixSpec JSON",
		);
		return {
			ok: false,
			summary: makeSummary(
				"failed",
				"analyzer did not return a valid FixSpec JSON",
			),
		};
	}
	await writeFile(
		join(ctx.runDir, "fix-spec.json"),
		`${JSON.stringify(fixSpec, null, 2)}\n`,
	);
	return { ok: true, fixSpec };
}

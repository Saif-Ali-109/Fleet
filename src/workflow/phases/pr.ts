import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WorktreeHandle } from "../../git/worktree.ts";
import { createPr } from "../../github/gh.ts";
import type { RunStatus, RunSummary } from "../../orchestrator.ts";
import { readContributionGuidance } from "../../orchestrator.ts";
import type { AgentResult, Role, RolePolicy, RunContext } from "../../types.ts";

export interface PrPhaseOpts {
	ctx: RunContext;
	wt: WorktreeHandle;
	runAgent: (
		role: Role,
		phase: "pr",
		task: string,
		policy: RolePolicy,
	) => Promise<AgentResult>;
	setPhase: (phase: "pr" | "failed") => void;
	pushState: () => void;
	finalize: (
		status: string,
		gateStatus: Record<string, unknown>,
		reason?: string,
	) => Promise<void>;
	makeSummary: (status: RunStatus, failure?: string) => RunSummary;
	agents: Record<Role, AgentResult>;
}

export type PrPhaseResult =
	| { ok: true; prUrl: string | undefined }
	| { ok: false; summary: RunSummary };

export async function runPrPhase(opts: PrPhaseOpts): Promise<PrPhaseResult> {
	const {
		ctx,
		wt,
		runAgent,
		setPhase,
		pushState,
		finalize,
		makeSummary,
		agents,
	} = opts;

	const extractPrUrl = (text: string): string | undefined =>
		/https?:\/\/[^\s)"']+\/pull\/\d+/.exec(text)?.[0];

	const prTask = [
		`Issue #${ctx.issue.number}: ${ctx.issue.title}`,
		"",
		ctx.issue.body,
		"",
		`The implementation is on branch ${ctx.branch} in ${ctx.worktreeDir}, based on ${wt.baseBranch}.`,
		`Push the branch to origin, then open a PR against ${wt.baseBranch} with \`gh pr create --repo ${ctx.issue.repo}\`.`,
		`PR title: Fix #${ctx.issue.number}: ${ctx.issue.title}`,
		`PR body must start with: Closes #${ctx.issue.number}`,
		`Managed run: ${ctx.runId}.`,
		"",
		await readContributionGuidance(ctx.worktreeDir),
	].join("\n");
	const pr = await runAgent("pr", "pr", prTask, {} as RolePolicy);
	let prUrl: string | undefined;
	if (pr.ok) {
		prUrl = extractPrUrl(pr.text);
	}
	if (!pr.ok || (!ctx.dryRun && !prUrl)) {
		if (ctx.dryRun) {
			prUrl = undefined;
		} else {
			let found = false;
			try {
				const exec = promisify(execFile);
				const { stdout } = await exec("gh", [
					"pr",
					"view",
					ctx.branch,
					"--repo",
					ctx.issue.repo,
					"--json",
					"url,number",
				]);
				const parsed = JSON.parse(stdout);
				if (typeof parsed?.url === "string" && parsed.url) {
					prUrl = parsed.url;
					found = true;
				}
			} catch {}
			if (!found) {
				try {
					const exec = promisify(execFile);
					await exec("git", [
						"-C",
						ctx.worktreeDir,
						"push",
						"-u",
						"origin",
						ctx.branch,
					]);
					const fallback = await createPr(ctx.issue.repo, {
						head: ctx.branch,
						base: wt.baseBranch,
						title: `Fix #${ctx.issue.number}: ${ctx.issue.title}`,
						body: `Closes #${ctx.issue.number}\n\nManaged run ${ctx.runId}.`,
					});
					prUrl = fallback.url || extractPrUrl(fallback.raw);
				} catch (e) {
					const m = /https?:\/\/[^\s)"']+/.exec(String(e));
					prUrl = m?.[0];
					if (!prUrl) {
						const { logLine } = await import("../../memory/sessionLog.ts");
						await logLine(
							ctx.rootDir,
							`PR creation failed and no PR URL recoverable: ${String(e)}`,
						);
					}
				}
			}
		}
	}

	if (!ctx.dryRun && !prUrl) {
		const prError = agents.pr && !agents.pr.ok ? agents.pr.error : undefined;
		const reason = prError
			? `no PR could be created (pr worker: ${prError})`
			: "no PR could be created";
		const { logLine } = await import("../../memory/sessionLog.ts");
		await logLine(ctx.rootDir, `PR gate failed: ${reason}`);
		setPhase("failed");
		pushState();
		await finalize("failed", {}, reason);
		return { ok: false, summary: makeSummary("failed", reason) };
	}

	return { ok: true, prUrl };
}

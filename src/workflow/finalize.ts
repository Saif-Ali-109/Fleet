import { db } from "../db/client.ts";
import type { WorktreeHandle } from "../git/worktree.ts";
import { cleanupWorktree } from "../git/worktree.ts";
import {
	addIssueLabel,
	commentOnIssue,
	ensureLabels,
	ISSUE_LABEL_DONE,
	ISSUE_LABEL_IN_PROGRESS,
	removeIssueLabel,
	splitRepoSlug,
} from "../github/gh.ts";
import type { SorEvent } from "../sor/events.ts";
import type { RunContext } from "../types.ts";

export interface FinalizeRunOpts {
	status: string;
	gateStatus: Record<string, unknown>;
	failureReason: string | null;
	prUrl: string | null;
	totalCostUsd: () => number;
	runId: string | null;
	ctx: RunContext;
	teardownPause: () => void;
	sorEmit: (ctx: RunContext, event: Partial<SorEvent>) => Promise<void>;
	writeResultFile: (status: string, reason: string | null) => Promise<void>;
	wt: WorktreeHandle | undefined;
}

export async function finalizeRun(opts: FinalizeRunOpts): Promise<void> {
	const {
		status,
		gateStatus,
		failureReason,
		prUrl,
		totalCostUsd,
		runId,
		ctx,
		teardownPause,
		sorEmit,
		writeResultFile,
		wt,
	} = opts;
	teardownPause();
	await sorEmit(ctx, {
		event_type: "finalize",
		actor: "manager",
		payload: {
			status,
			pr_url: prUrl ?? null,
			total_cost: totalCostUsd(),
			failure: failureReason ?? null,
		},
	});
	if (runId) {
		await db.finalizeRun({
			run_id: runId,
			pr_url: prUrl ?? null,
			total_cost: totalCostUsd(),
			gate_status: JSON.stringify(gateStatus),
			status,
		});
	}
	if (status === "failed") {
		await writeResultFile(status, failureReason);
	}
	if (!ctx.dryRun) {
		const { owner, repo } = splitRepoSlug(ctx.issue.repo);
		try {
			await ensureLabels(owner, repo, [
				ISSUE_LABEL_IN_PROGRESS,
				ISSUE_LABEL_DONE,
			]);
			await removeIssueLabel(
				owner,
				repo,
				ctx.issue.number,
				ISSUE_LABEL_IN_PROGRESS,
			);
			if (status === "completed") {
				await addIssueLabel(owner, repo, ctx.issue.number, ISSUE_LABEL_DONE);
				const lines = [
					`Managed run \`${ctx.runId}\` completed.`,
					prUrl ? `- PR: ${prUrl}` : "- PR: (none)",
					`- Total cost: $${totalCostUsd().toFixed(4)}`,
					`- Backend: ${ctx.provider ?? "gemini"}`,
				].join("\n");
				await commentOnIssue(owner, repo, ctx.issue.number, lines);
			} else {
				const suffix = failureReason ? `: ${failureReason}` : "";
				await commentOnIssue(
					owner,
					repo,
					ctx.issue.number,
					`Managed run \`${ctx.runId}\` ${status}${suffix}.`,
				);
			}
		} catch (e) {
			console.warn(
				`[lifecycle] finalize (${status}) failed (non-fatal): ${String(e)}`,
			);
		}
	}
	if (wt && !ctx.dryRun) {
		try {
			await cleanupWorktree(wt, !ctx.cloneDir);
		} catch (e) {
			console.warn(`[worktree] cleanup failed (non-fatal): ${String(e)}`);
		}
	}
}

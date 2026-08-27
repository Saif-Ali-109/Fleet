import { hasIssueLabel, hasOpenPrForBranch, ISSUE_LABEL_DONE, splitRepoSlug } from "../github/gh.ts";

/** Branch name for the fix PR of an issue, e.g. `fix-issue-5`. */
export function fixBranchName(issueNumber: number): string {
  return `fix-issue-${issueNumber}`;
}

export interface ShouldSkipIssueOpts {
  /** Repo URL or `owner/name` slug the issue lives in (any casing). */
  repoUrlOrSlug: string;
  /** GitHub issue number. */
  issueNumber: number;
  /** Best-effort DB signal: true when a `run_outcomes` row reached `completed`. */
  completedRun: boolean;
}

/**
 * True when a daemon rescan should skip an issue that is already handled.
 *
 * Decision tree (any true → skip):
 *  1. An OPEN PR exists on the fix branch.
 *  2. The issue carries the `multi-orch/done` label — the robust cross-machine
 *     truth. Unlike the DB `LIMIT 1` lookup it can't be masked by a newer
 *     failed/aborted run, and it doesn't lag behind writes on another machine.
 *  3. A completed `run_outcomes` row exists (best-effort secondary).
 *
 * `hasOpenPrForBranch` returns null on a genuine "no open PR" and THROWS on gh
 * failure (auth/rate-limit/network), so a gh outage surfaces here instead of
 * being misread as "no PR". The DB fallback is only reached on a genuine empty
 * result. `hasIssueLabel` remains non-fatal (returns false on any gh failure)
 * so a label-check hiccup never blocks a re-run. The `multi-orch/in-progress`
 * label intentionally does NOT block (crash-safety): a dead orchestrator may
 * leave one behind and the daemon must be able to re-run.
 */
export async function shouldSkipIssue(opts: ShouldSkipIssueOpts): Promise<boolean> {
  // One canonical lowercase slug for every check so `Owner/Repo` vs
  // `owner/repo` can never fork the dedup identity.
  const repoSlug = opts.repoUrlOrSlug.toLowerCase();
  const hasOpenPr = await hasOpenPrForBranch(
    repoSlug,
    fixBranchName(opts.issueNumber),
  );
  if (hasOpenPr === true) {
    return true;
  }
  const { owner, repo } = splitRepoSlug(repoSlug);
  if (await hasIssueLabel(owner, repo, opts.issueNumber, ISSUE_LABEL_DONE)) {
    return true;
  }
  return opts.completedRun;
}

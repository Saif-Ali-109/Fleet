/** Branch name for the fix PR of an issue, e.g. `fix-issue-5`. */
export function fixBranchName(issueNumber: number): string {
  return `fix-issue-${issueNumber}`;
}

/** True when a daemon rescan should skip an issue that is already handled. */
export function shouldSkipIssue(opts: {
  completedRun: boolean;
  openPrOnBranch: boolean;
}): boolean {
  return opts.completedRun || opts.openPrOnBranch;
}
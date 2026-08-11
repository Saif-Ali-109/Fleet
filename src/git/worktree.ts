import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const exec = promisify(execFile);

/** Run git with argv (no shell). Returns stdout trimmed. */
async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout.trim();
}

export interface WorktreeHandle {
  repoDir: string; // the bare-ish clone used as the worktree source
  worktreeDir: string; // .runs/<id>/worktree  — the ONLY place workers edit
  branch: string;
  baseBranch: string;
}

/**
 * Clone `repoUrl` once into `runDir/repo`, then create a fix branch in a linked
 * worktree at `runDir/worktree`. All worker edits are confined to the worktree; the
 * user's environment and any existing checkout are never touched.
 */
export async function setupWorktree(
  repoUrl: string,
  runDir: string,
  branch: string,
): Promise<WorktreeHandle> {
  const repoDir = join(runDir, "repo");
  const worktreeDir = join(runDir, "worktree");
  await mkdir(runDir, { recursive: true });

  await git(["clone", "--quiet", repoUrl, repoDir]);
  const baseBranch = await git(["rev-parse", "--abbrev-ref", "HEAD"], repoDir);

  // Fresh branch off the base, checked out in a linked worktree.
  await git(["worktree", "add", "-b", branch, worktreeDir, baseBranch], repoDir);

  return { repoDir, worktreeDir, branch, baseBranch };
}

/** Diff of the worktree against the base branch (what the human approves at GATE 3). */
export async function diffAgainstBase(h: WorktreeHandle): Promise<string> {
  return git(["diff", `${h.baseBranch}...HEAD`], h.worktreeDir);
}

/** File-level stat diff of the worktree against the base branch (compact summary for sign-off gates). */
export async function diffStatAgainstBase(h: WorktreeHandle): Promise<string> {
  return git(["diff", "--stat", `${h.baseBranch}...HEAD`], h.worktreeDir);
}

/** True if the worktree has commits beyond the base branch. */
export async function hasCommits(h: WorktreeHandle): Promise<boolean> {
  const out = await git(["rev-list", "--count", `${h.baseBranch}..HEAD`], h.worktreeDir);
  return Number(out) > 0;
}

/** Names of files changed vs base (for quick summaries). */
export async function changedFiles(h: WorktreeHandle): Promise<string[]> {
  const out = await git(["diff", "--name-only", `${h.baseBranch}...HEAD`], h.worktreeDir);
  return out ? out.split("\n").filter(Boolean) : [];
}

/** Remove the linked worktree (keeps the clone unless `full`). */
export async function cleanupWorktree(h: WorktreeHandle, full = false): Promise<void> {
  if (existsSync(h.worktreeDir)) {
    try {
      await git(["worktree", "remove", "--force", h.worktreeDir], h.repoDir);
    } catch {
      await rm(h.worktreeDir, { recursive: true, force: true });
    }
  }
  if (full && existsSync(h.repoDir)) {
    await rm(h.repoDir, { recursive: true, force: true });
  }
}

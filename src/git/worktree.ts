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

/** Undo git's C-style quoting of a path (`git worktree list --porcelain`). */
function unquoteGitPath(s: string): string {
  if (!s.includes("\\")) return s;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== "\\") {
      out += c;
    } else {
      const n = s[i + 1];
      if (n !== undefined && /[0-7]/.test(n)) {
        let v = 0;
        let j = i + 1;
        while (j < s.length && j < i + 4 && /[0-7]/.test(s[j] ?? "")) {
          v = v * 8 + (s.charCodeAt(j) - 48);
          j++;
        }
        out += String.fromCharCode(v);
        i = j - 1;
      } else {
        const escapes: Record<string, string> = {
          n: "\n",
          t: "\t",
          '"': '"',
          "\\": "\\",
          " ": " ",
        };
        out += n !== undefined ? (escapes[n] ?? n) : "\\";
        i++;
      }
    }
  }
  return out;
}

interface ListedWorktree {
  path: string;
  branch?: string;
}

/** Registered linked worktrees of `repoDir` (the clone's own tree is included). */
async function listWorktrees(repoDir: string): Promise<ListedWorktree[]> {
  const out = await git(["worktree", "list", "--porcelain"], repoDir);
  const worktrees: ListedWorktree[] = [];
  let current: ListedWorktree | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) worktrees.push(current);
      current = { path: unquoteGitPath(line.slice("worktree ".length)) };
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    }
  }
  if (current) worktrees.push(current);
  return worktrees;
}

/**
 * Remove stale linked worktrees a crashed/failed prior run left registered
 * against the reused clone. A leftover worktree dir survives `git worktree
 * prune` and its branch stays checked out, so the next `worktree add -b` (and
 * the `branch -D` before it) would throw forever. The clone's own working tree
 * is never touched.
 */
async function removeStaleWorktrees(
  repoDir: string,
  worktreeDir: string,
  branch: string,
): Promise<void> {
  const branchRef = `refs/heads/${branch}`;
  let worktrees: ListedWorktree[];
  try {
    worktrees = await listWorktrees(repoDir);
  } catch (e) {
    console.warn(`[worktree] could not list registered worktrees (non-fatal): ${String(e)}`);
    return;
  }
  const stale = worktrees.filter(
    (w) =>
      w.path !== repoDir &&
      w.path !== join(repoDir, ".") &&
      (w.path === worktreeDir ||
        w.path.startsWith(worktreeDir + "/") ||
        w.branch === branchRef),
  );
  for (const w of stale) {
    try {
      await git(["worktree", "remove", "--force", w.path], repoDir);
    } catch {
      await rm(w.path, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * Refresh a reused session clone so a new run branches off the latest upstream
 * state, not the state left by the previous run. Best-effort throughout: a fetch
 * or ref-sync failure falls back to whatever local state the clone already has,
 * so a flaky network never aborts the run (AGENTS.md: all cleanup/fetch is
 * non-fatal).
 */
async function refreshReusedClone(repoDir: string, branch: string, worktreeDir: string): Promise<void> {
  try {
    await git(["fetch", "--quiet", "--prune", "origin"], repoDir);
  } catch (e) {
    console.warn(`[worktree] fetch of reused clone failed (non-fatal): ${String(e)}`);
  }
  // A crashed prior run may have left a registered-but-broken worktree at our
  // run dir (dir still on disk, branch still checked out). `git worktree
  // prune` alone keeps it because the dir exists, so remove it explicitly
  // before `worktree add -b` throws forever.
  await removeStaleWorktrees(repoDir, worktreeDir, branch);
  try {
    await git(["worktree", "prune"], repoDir);
  } catch (e) {
    console.warn(`[worktree] worktree prune failed (non-fatal): ${String(e)}`);
  }
  // Move the local default branch to the fetched remote tip so the new worktree
  // branches off the latest default. Done with update-ref (works even when the
  // branch is checked out in the clone's own working tree).
  try {
    const remoteHead = await git(
      ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
      repoDir,
    ).catch(() => git(["rev-parse", "--abbrev-ref", "HEAD"], repoDir));
    const branchName = remoteHead.replace(/^refs\/remotes\/origin\//, "");
    await git(["update-ref", `refs/heads/${branchName}`, `refs/remotes/origin/${branchName}`], repoDir);
  } catch (e) {
    console.warn(`[worktree] default-branch sync failed (non-fatal): ${String(e)}`);
  }
  // A prior run in this session may have left the fix branch in the shared clone
  // (`git worktree remove` keeps refs). Drop it so `worktree add -b` never
  // collides; its stale worktree (if any) was already removed above, so the
  // branch is no longer checked out anywhere.
  try {
    await git(["branch", "-D", branch], repoDir);
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    const msg = (err.stderr ?? err.message ?? String(e)).trim();
    if (/\bnot found\b|No such branch|does not exist/i.test(msg)) {
      // Branch never existed (or a prior clean run already dropped it) — nothing to delete.
    } else {
      console.warn(`[worktree] failed to drop stale branch "${branch}" (non-fatal): ${msg}`);
    }
  }
}

/**
 * Prepare a run's linked git worktree.
 *
 * With no `existingRepoDir` this clones `repoUrl` once into `runDir/repo` and
 * creates the fix branch in a linked worktree at `runDir/worktree` (unchanged
 * behavior). When `existingRepoDir` is provided the clone is skipped entirely:
 * the session-level clone is fetched and a fresh worktree is linked against it,
 * so a daemon fixing many issues in one repo pays the clone cost only once.
 */
export async function setupWorktree(
  repoUrl: string,
  runDir: string,
  branch: string,
  existingRepoDir?: string,
): Promise<WorktreeHandle> {
  const repoDir = existingRepoDir ?? join(runDir, "repo");
  const worktreeDir = join(runDir, "worktree");
  await mkdir(runDir, { recursive: true });

  if (existingRepoDir) {
    await refreshReusedClone(existingRepoDir, branch, worktreeDir);
  } else {
    await git(["clone", "--quiet", repoUrl, repoDir]);
  }

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

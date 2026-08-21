import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupWorktree, setupWorktree } from "../git/worktree.ts";

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

/** A local "remote" repo with one commit on the default branch. */
function mkRemote(): { remote: string } {
  const remote = mkdtempSync(join(tmpdir(), "worktree-remote-"));
  git(remote, ["init", "-q", "-b", "main"]);
  git(remote, ["config", "user.name", "Test"]);
  git(remote, ["config", "user.email", "test@example.com"]);
  writeFileSync(join(remote, "base.txt"), "hello\n", "utf8");
  git(remote, ["add", "."]);
  git(remote, ["commit", "-q", "-m", "base"]);
  return { remote };
}

function newRunDir(tag: string): string {
  return mkdtempSync(join(tmpdir(), `worktree-${tag}-`));
}

describe("setupWorktree", () => {
  it("clones fresh when no existing repo dir is passed", async () => {
    const { remote } = mkRemote();
    const run = newRunDir("fresh");
    try {
      const h = await setupWorktree(remote, run, "fix-issue-1");
      expect(existsSync(join(run, "repo"))).toBe(true);
      expect(h.repoDir).toBe(join(run, "repo"));
      expect(h.baseBranch).toBe("main");
      expect(git(h.worktreeDir, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("fix-issue-1");
    } finally {
      rmSync(run, { recursive: true, force: true });
    }
  });

  it("reuses an existing clone dir instead of cloning a second time", async () => {
    const { remote } = mkRemote();
    const run1 = newRunDir("reuse1");
    const run2 = newRunDir("reuse2");
    try {
      const first = await setupWorktree(remote, run1, "fix-issue-1");

      // The remote advances between issues, as it would in a long daemon session.
      writeFileSync(join(remote, "new.txt"), "later\n", "utf8");
      git(remote, ["add", "."]);
      git(remote, ["commit", "-q", "-m", "upstream advance"]);
      const latestTip = git(remote, ["rev-parse", "HEAD"]).trim();

      const second = await setupWorktree(remote, run2, "fix-issue-2", first.repoDir);

      // No second clone: the reused dir is the first run's clone, not run2/repo.
      expect(second.repoDir).toBe(first.repoDir);
      expect(existsSync(join(run2, "repo"))).toBe(false);
      // Fetch + base sync means the new worktree branches off the LATEST upstream.
      expect(git(second.worktreeDir, ["rev-parse", "HEAD"]).trim()).toBe(latestTip);
      expect(git(second.worktreeDir, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("fix-issue-2");
    } finally {
      rmSync(run1, { recursive: true, force: true });
      rmSync(run2, { recursive: true, force: true });
    }
  });

  it("re-creates a fix branch a prior run left behind in the shared clone", async () => {
    const { remote } = mkRemote();
    const run1 = newRunDir("stale1");
    const run2 = newRunDir("stale2");
    try {
      const first = await setupWorktree(remote, run1, "fix-issue-7");
      // Simulate a finished run: the worktree is removed but its branch stays in
      // the shared clone (`git worktree remove` keeps refs).
      await cleanupWorktree(first);
      expect(existsSync(first.worktreeDir)).toBe(false);

      const second = await setupWorktree(remote, run2, "fix-issue-7", first.repoDir);
      expect(second.worktreeDir).not.toBe(first.worktreeDir);
      expect(git(second.worktreeDir, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("fix-issue-7");
    } finally {
      rmSync(run1, { recursive: true, force: true });
      rmSync(run2, { recursive: true, force: true });
    }
  });

  it("recovers when a crashed run left a registered-but-broken worktree in the shared clone", async () => {
    const { remote } = mkRemote();
    const run1 = newRunDir("crashed1");
    const run2 = newRunDir("crashed2");
    try {
      // First attempt crashes mid-run: the clone, the worktree dir, and its
      // registration (branch fix-issue-9 checked out) all survive untouched.
      const crashed = await setupWorktree(remote, run1, "fix-issue-9");
      expect(existsSync(crashed.worktreeDir)).toBe(true);

      // The daemon re-scans the same issue and reuses the same session clone with
      // a fresh run dir. `git worktree prune` alone would keep the stale worktree
      // (its dir still exists), so `worktree add -b` used to throw forever.
      const retry = await setupWorktree(remote, run2, "fix-issue-9", crashed.repoDir);

      expect(existsSync(crashed.worktreeDir)).toBe(false);
      expect(existsSync(retry.worktreeDir)).toBe(true);
      expect(git(retry.worktreeDir, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("fix-issue-9");
      // The clone itself is intact, not blown away.
      expect(existsSync(retry.repoDir)).toBe(true);
    } finally {
      rmSync(run1, { recursive: true, force: true });
      rmSync(run2, { recursive: true, force: true });
    }
  });
});
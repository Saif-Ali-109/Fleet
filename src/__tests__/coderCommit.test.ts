import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitMessageFor } from "../orchestrator.ts";
import { commitChanges } from "../workflow/coder.ts";
import type { Issue, Plan, RolePolicy, RunContext } from "../types.ts";

function fakeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "coder-commit-"));
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
  return dir;
}

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

function ctxFor(dir: string): RunContext {
  return { runId: "test", dryRun: false, worktreeDir: dir } as unknown as RunContext;
}

function optsFor(dir: string, commitMessage?: string) {
  return {
    task: "test",
    policy: {} as RolePolicy,
    worktreeDir: dir,
    branch: "fix-branch",
    commitMessage,
  };
}

function planFor(approach: string): Plan {
  return {
    approach,
    steps: ["step"],
    filesToChange: [],
    testsToAddOrUpdate: [],
    acceptanceCriteria: [],
    outOfScope: [],
  };
}

const issue: Issue = {
  repo: "owner/repo",
  number: 42,
  title: "Range bug",
  body: "",
  url: "",
  state: "open",
  labels: [],
  author: "test",
};

describe("commitMessageFor", () => {
  it("derives a factual subject from plan.approach", () => {
    expect(commitMessageFor(planFor("Validate the range before emit"), issue)).toBe(
      "fix: validate the range before emit",
    );
  });

  it("drops a leading imperative Fix/Fixes", () => {
    expect(commitMessageFor(planFor("Fix bug by validating range"), issue)).toBe(
      "fix: bug by validating range",
    );
    expect(commitMessageFor(planFor("Fixes the flaky test selector"), issue)).toBe(
      "fix: the flaky test selector",
    );
  });

  it("uses only the first line and trims trailing punctuation", () => {
    expect(
      commitMessageFor(
        planFor("Validate the range before emit.\nThen add a regression test."),
        issue,
      ),
    ).toBe("fix: validate the range before emit");
  });

  it("caps the subject at 72 chars", () => {
    const long = "A".repeat(200);
    const msg = commitMessageFor(planFor(long), issue);
    expect(msg.length).toBeLessThanOrEqual(72);
    expect(msg).toMatch(/^fix: .*…$/);
  });

  it("throws on an empty approach", () => {
    expect(() => commitMessageFor(planFor("   "), issue)).toThrow(/empty/);
  });
});

describe("commitChanges", () => {
  it("skips the commit when the worktree is clean", async () => {
    const dir = fakeRepo();
    try {
      writeFileSync(join(dir, "base.txt"), "hello\n", "utf8");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-q", "-m", "base"]);
      expect(git(dir, ["rev-list", "--count", "HEAD"]).trim()).toBe("1");

      await commitChanges(ctxFor(dir), optsFor(dir, "fix: should not run"), "commit");
      expect(git(dir, ["rev-list", "--count", "HEAD"]).trim()).toBe("1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates a commit with the given factual message when there are changes", async () => {
    const dir = fakeRepo();
    try {
      writeFileSync(join(dir, "base.txt"), "hello\n", "utf8");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-q", "-m", "base"]);

      writeFileSync(join(dir, "fixed.txt"), "fixed\n", "utf8");
      await commitChanges(ctxFor(dir), optsFor(dir, "fix: validate range before emit"), "commit");

      expect(git(dir, ["rev-list", "--count", "HEAD"]).trim()).toBe("2");
      expect(git(dir, ["log", "-1", "--format=%s"]).trim()).toBe("fix: validate range before emit");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no-ops in dry-run mode", async () => {
    const dir = fakeRepo();
    try {
      writeFileSync(join(dir, "base.txt"), "hello\n", "utf8");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-q", "-m", "base"]);

      writeFileSync(join(dir, "pending.txt"), "unstaged\n", "utf8");
      const ctx = { ...ctxFor(dir), dryRun: true };
      await commitChanges(ctx, optsFor(dir, "fix: never"), "commit");

      expect(git(dir, ["rev-list", "--count", "HEAD"]).trim()).toBe("1");
      expect(git(dir, ["status", "--porcelain"]).trim()).toContain("pending.txt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips commit when only untracked __pycache__/ is present", async () => {
    const dir = fakeRepo();
    try {
      writeFileSync(join(dir, "base.txt"), "hello\n", "utf8");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-q", "-m", "base"]);

      // Simulate a worker running python, creating untracked __pycache__/
      mkdirSync(join(dir, "__pycache__"), { recursive: true });
      writeFileSync(join(dir, "__pycache__/mod.cpython-311.pyc"), "pyc", "utf8");

      await commitChanges(ctxFor(dir), optsFor(dir, "fix: should skip"), "commit");
      expect(git(dir, ["rev-list", "--count", "HEAD"]).trim()).toBe("1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not commit .pytest_cache/ when present", async () => {
    const dir = fakeRepo();
    try {
      writeFileSync(join(dir, "base.txt"), "hello\n", "utf8");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-q", "-m", "base"]);

      // Simulate a worker running pytest, creating untracked .pytest_cache/
      mkdirSync(join(dir, ".pytest_cache/v/cache"), { recursive: true });
      writeFileSync(join(dir, ".pytest_cache/v/cache/lastfailed"), "{}", "utf8");

      await commitChanges(ctxFor(dir), optsFor(dir, "fix: should skip"), "commit");
      expect(git(dir, ["rev-list", "--count", "HEAD"]).trim()).toBe("1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still commits real changes even with __pycache__/ present", async () => {
    const dir = fakeRepo();
    try {
      writeFileSync(join(dir, "base.txt"), "hello\n", "utf8");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-q", "-m", "base"]);

      writeFileSync(join(dir, "fixed.txt"), "fixed\n", "utf8");
      mkdirSync(join(dir, "__pycache__"), { recursive: true });
      writeFileSync(join(dir, "__pycache__/x.pyc"), "pyc", "utf8");

      await commitChanges(ctxFor(dir), optsFor(dir, "fix: real change"), "commit");
      expect(git(dir, ["rev-list", "--count", "HEAD"]).trim()).toBe("2");
      expect(git(dir, ["log", "-1", "--format=%s"]).trim()).toBe("fix: real change");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
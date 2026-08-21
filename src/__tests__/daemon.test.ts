import { afterEach, describe, expect, it, vi } from "vitest";

const { execFileMock, spawnMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  spawnMock: vi.fn(),
}));

// gh.ts shells out through promisified execFile/spawn from node:child_process.
// Mock the module so no real `gh` binary is ever invoked in tests.
vi.mock("node:child_process", () => ({
  execFile: execFileMock,
  spawn: spawnMock,
}));

import { fixBranchName, shouldSkipIssue } from "../daemon/dedup.ts";
import { hasOpenPrForBranch } from "../github/gh.ts";

function rejectWith(message: string): void {
  execFileMock.mockImplementation(
    (_file: string, _args: string[], _opts: unknown, cb: (err: Error | null, out?: string, errOut?: string) => void) => {
      const err = new Error(message) as Error & { stderr?: string };
      err.stderr = message;
      cb(err, "", message);
    },
  );
}

/**
 * Route `gh` responses per subcommand:
 *  - `pr list  --head fix-issue-<n>` → `openPr` ? a non-empty array : `[]`
 *  - `issue view ... --json labels` → the given labels
 *  - anything else → `[]`
 */
function routeGh(opts: { openPr: boolean; labels: string[] }): void {
  execFileMock.mockImplementation(
    (_file: string, args: string[], _opts: unknown, cb: (err: Error | null, out?: unknown, errOut?: string) => void) => {
      const a = args as string[];
      if (a[0] === "pr") {
        cb(null, { stdout: opts.openPr ? '[{"number": 1}]' : "[]", stderr: "" });
        return;
      }
      if (a[0] === "issue") {
        const labels = opts.labels.map((name) => ({ name }));
        cb(null, { stdout: JSON.stringify({ labels }), stderr: "" });
        return;
      }
      cb(null, { stdout: "[]", stderr: "" });
    },
  );
}

afterEach(() => {
  execFileMock.mockReset();
});

describe("fixBranchName", () => {
  it("produces fix-issue-5 for issue 5", () => {
    expect(fixBranchName(5)).toBe("fix-issue-5");
  });

  it("produces fix-issue-123 for issue 123", () => {
    expect(fixBranchName(123)).toBe("fix-issue-123");
  });
});

describe("shouldSkipIssue", () => {
  const base = {
    repoUrlOrSlug: "owner/repo",
    issueNumber: 5,
    completedRun: false,
  };

  it("queries the fix branch by fix-issue-<n>", async () => {
    routeGh({ openPr: true, labels: [] });
    await shouldSkipIssue(base);
    const prCall = execFileMock.mock.calls.find((c) => (c[1] as string[])[0] === "pr");
    expect(prCall?.[1]).toEqual([
      "pr",
      "list",
      "--repo",
      "owner/repo",
      "--head",
      "fix-issue-5",
      "--state",
      "open",
      "--json",
      "number",
    ]);
  });

  it("checks the done label via the issue view", async () => {
    routeGh({ openPr: false, labels: [] });
    await shouldSkipIssue(base);
    const labelCall = execFileMock.mock.calls.find((c) => (c[1] as string[])[0] === "issue");
    expect(labelCall?.[1]).toEqual([
      "issue",
      "view",
      "5",
      "--repo",
      "owner/repo",
      "--json",
      "labels",
    ]);
  });

  it("skips when the run is completed even with no open PR and no done label", async () => {
    routeGh({ openPr: false, labels: [] });
    await expect(
      shouldSkipIssue({ ...base, completedRun: true }),
    ).resolves.toBe(true);
  });

  it("skips when there is an open PR even without a completed run", async () => {
    routeGh({ openPr: true, labels: [] });
    await expect(shouldSkipIssue(base)).resolves.toBe(true);
  });

  it("skips when both the run is completed and there is an open PR", async () => {
    routeGh({ openPr: true, labels: [] });
    await expect(
      shouldSkipIssue({ ...base, completedRun: true }),
    ).resolves.toBe(true);
  });

  it("skips when the multi-orch/done label is present", async () => {
    routeGh({ openPr: false, labels: ["multi-orch/done"] });
    await expect(shouldSkipIssue(base)).resolves.toBe(true);
  });

  it("skips on the done label even when other labels are present", async () => {
    routeGh({ openPr: false, labels: ["bug", "multi-orch/done", "priority"] });
    await expect(shouldSkipIssue(base)).resolves.toBe(true);
  });

  it("does NOT skip on the in-progress label alone (crash-safety)", async () => {
    routeGh({ openPr: false, labels: ["multi-orch/in-progress"] });
    await expect(shouldSkipIssue(base)).resolves.toBe(false);
  });

  it("does NOT skip when the run is incomplete, no PR is open, and no done label", async () => {
    routeGh({ openPr: false, labels: [] });
    await expect(shouldSkipIssue(base)).resolves.toBe(false);
  });

  it("surfaces gh failures instead of treating them as 'no PR'", async () => {
    rejectWith("gh not found");
    await expect(shouldSkipIssue(base)).rejects.toThrow("gh not found");
    await expect(
      shouldSkipIssue({ ...base, completedRun: true }),
    ).rejects.toThrow("gh not found");
  });
});

describe("hasOpenPrForBranch", () => {
  it("returns true when an open PR exists on the head branch", async () => {
    routeGh({ openPr: true, labels: [] });
    await expect(
      hasOpenPrForBranch("owner/repo", "fix-issue-5"),
    ).resolves.toBe(true);
  });

  it("returns null when there is genuinely no open PR", async () => {
    routeGh({ openPr: false, labels: [] });
    await expect(
      hasOpenPrForBranch("owner/repo", "fix-issue-5"),
    ).resolves.toBeNull();
  });

  it("throws when the gh command fails", async () => {
    rejectWith("could not resolve host");
    await expect(
      hasOpenPrForBranch("owner/repo", "fix-issue-5"),
    ).rejects.toThrow("could not resolve host");
  });
});
import { describe, it, expect } from "vitest";
import { fixBranchName, shouldSkipIssue } from "../daemon/dedup.js";

describe("fixBranchName", () => {
  it("produces fix-issue-5 for issue 5", () => {
    expect(fixBranchName(5)).toBe("fix-issue-5");
  });

  it("produces fix-issue-123 for issue 123", () => {
    expect(fixBranchName(123)).toBe("fix-issue-123");
  });
});

describe("shouldSkipIssue", () => {
  it("skips when the run is completed even with no open PR", () => {
    expect(shouldSkipIssue({ completedRun: true, openPrOnBranch: false })).toBe(
      true,
    );
  });

  it("skips when there is an open PR even without a completed run", () => {
    expect(shouldSkipIssue({ completedRun: false, openPrOnBranch: true })).toBe(
      true,
    );
  });

  it("skips when both the run is completed and there is an open PR", () => {
    expect(shouldSkipIssue({ completedRun: true, openPrOnBranch: true })).toBe(
      true,
    );
  });

  it("does not skip when the run is incomplete and no PR is open", () => {
    expect(shouldSkipIssue({ completedRun: false, openPrOnBranch: false })).toBe(
      false,
    );
  });
});
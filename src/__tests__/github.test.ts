import { describe, it, expect } from "vitest";
import { splitRepoSlug, stubIssue, toRepoSlug } from "../github/gh.ts";

describe("toRepoSlug", () => {
  it("passes through an owner/name slug untouched", () => {
    expect(toRepoSlug("owner/repo")).toBe("owner/repo");
  });

  it("strips a trailing .git from a slug", () => {
    expect(toRepoSlug("owner/repo.git")).toBe("owner/repo");
  });

  it("extracts owner/name from an HTTPS URL", () => {
    expect(toRepoSlug("https://github.com/owner/repo")).toBe("owner/repo");
  });

  it("extracts owner/name from an HTTPS URL ending in .git", () => {
    expect(toRepoSlug("https://github.com/owner/repo.git")).toBe("owner/repo");
  });

  it("extracts owner/name from an SSH URL", () => {
    expect(toRepoSlug("git@github.com:owner/repo.git")).toBe("owner/repo");
  });

  it("extracts owner/name from an SSH URL without .git", () => {
    expect(toRepoSlug("git@github.com:owner/repo")).toBe("owner/repo");
  });

  it("trims surrounding whitespace", () => {
    expect(toRepoSlug("  owner/repo  ")).toBe("owner/repo");
  });

  it("throws for a slug that is not owner/name", () => {
    expect(() => toRepoSlug("just-a-repo")).toThrow(/Cannot derive/);
  });

  it("throws for an empty string", () => {
    expect(() => toRepoSlug("")).toThrow(/Cannot derive/);
  });

  it("throws for a URL without owner/name", () => {
    expect(() => toRepoSlug("https://github.com")).toThrow(/Cannot derive/);
  });
});

describe("splitRepoSlug", () => {
  it("splits an owner/name slug", () => {
    expect(splitRepoSlug("owner/repo")).toEqual({ owner: "owner", repo: "repo" });
  });

  it("splits an HTTPS repo URL", () => {
    expect(splitRepoSlug("https://github.com/owner/repo.git")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  it("splits an SSH repo URL", () => {
    expect(splitRepoSlug("git@github.com:owner/repo.git")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  it("throws for an input that is not owner/name", () => {
    expect(() => splitRepoSlug("just-a-repo")).toThrow(/Cannot derive/);
  });
});

describe("stubIssue", () => {
  it("returns an issue with the expected shape", () => {
    const issue = stubIssue("owner/repo", 42);
    expect(issue).toEqual({
      repo: "owner/repo",
      number: 42,
      title: "[dry-run] stub",
      body: "",
      url: "",
      labels: [],
      author: "stub",
      state: "open",
    });
  });

  it("passes an owner/name slug through toRepoSlug unchanged into repo", () => {
    const issue = stubIssue("owner/name", 1);
    expect(issue.repo).toBe("owner/name");
  });

  it("accepts an HTTPS URL and produces repo owner/name", () => {
    const issue = stubIssue("https://github.com/owner/name", 1);
    expect(issue.repo).toBe("owner/name");
  });

  it("uses the passed number", () => {
    expect(stubIssue("owner/repo", 7).number).toBe(7);
    expect(stubIssue("owner/repo", 123).number).toBe(123);
  });
});

import { describe, it, expect } from "vitest";
import { planRoute, MAX_IMPL_ITERATIONS } from "../router.ts";
import type { Issue } from "../types.ts";

function makeIssue(overrides: Partial<Omit<Issue, "state">> & { state?: Issue["state"] } = {}): Issue {
  const base: Issue = {
    repo: "owner/repo",
    number: 42,
    title: "Some bug",
    body: "Something is broken",
    url: "https://github.com/owner/repo/issues/42",
    state: "open",
    labels: [],
    author: "someone",
  };
  return { ...base, ...overrides };
}

describe("planRoute", () => {
  it("produces the fixed 5-step spine in order", () => {
    const route = planRoute(makeIssue());
    expect(route.map((s) => s.kind)).toEqual([
      "single",
      "single",
      "loop",
      "single",
      "single",
    ]);
    expect(route.map((s) => s.roles)).toEqual([
      ["analyzer"],
      ["planner"],
      ["coder", "tester"],
      ["reviewer"],
      ["pr"],
    ]);
  });

  it("runs coder + tester concurrently in the loop for a normal issue", () => {
    const route = planRoute(makeIssue({ title: "Fix the crash in Foo.bar" }));
    const loop = route.find((s) => s.kind === "loop")!;
    expect(loop.roles).toEqual(["coder", "tester"]);
  });

  it("skips the dedicated tester for documentation issues", () => {
    const route = planRoute(
      makeIssue({ title: "Fix typo in README", labels: ["documentation"] }),
    );
    const docsLoop = route.find((s) => s.kind === "loop")!;
    expect(docsLoop.roles).toEqual(["coder"]);
  });

  it("skips the tester when the body contains 'docs'", () => {
    const route = planRoute(
      makeIssue({ title: "Update docs", body: "Please update the docs for the API." }),
    );
    const docsLoop = route.find((s) => s.kind === "loop")!;
    expect(docsLoop.roles).toEqual(["coder"]);
  });

  it("skips the tester for 'typo' in the title", () => {
    const route = planRoute(makeIssue({ title: "Fix a typo in the comment" }));
    const docsLoop = route.find((s) => s.kind === "loop")!;
    expect(docsLoop.roles).toEqual(["coder"]);
  });

  it("skips the tester for 'wording' in the body", () => {
    const route = planRoute(
      makeRole("wording issue"),
    );
    const docsLoop = route.find((s) => s.kind === "loop")!;
    expect(docsLoop.roles).toEqual(["coder"]);
  });

  it("is case-insensitive when classifying docs issues", () => {
    const route = planRoute(
      makeIssue({ title: "README: fix README section" }),
    );
    const docsLoop = route.find((s) => s.kind === "loop")!;
    expect(docsLoop.roles).toEqual(["coder"]);
  });

  it("uses 'comment' as a docs trigger in the title", () => {
    const route = planRoute(makeIssue({ title: "Fix misleading comment" }));
    const docsLoop = route.find((s) => s.kind === "loop")!;
    expect(docsLoop.roles).toEqual(["coder"]);
  });

  it("keeps the coder+tester loop when labels contain 'bug'", () => {
    const route = planRoute(makeIssue({ title: "Broken widget", labels: ["bug"] }));
    const loop = route.find((s) => s.kind === "loop")!;
    expect(loop.roles).toEqual(["coder", "tester"]);
  });

  it("does not mutate the input issue", () => {
    const issue = makeIssue({ labels: ["documentation"] });
    const snapshot = JSON.parse(JSON.stringify(issue));
    planRoute(issue);
    expect(issue).toEqual(snapshot);
  });
});

describe("MAX_IMPL_ITERATIONS", () => {
  it("is 3", () => {
    expect(MAX_IMPL_ITERATIONS).toBe(3);
  });
});

// helper used by the 'wording' test above
function makeRole(bodyText: string): Issue {
  return makeIssue({ title: "Improve wording", body: bodyText, state: "open" });
}

import { describe, expect, it } from "vitest";
import { MAX_IMPL_ITERATIONS, planRoute } from "../router.ts";
import type { Issue } from "../types.ts";

function makeIssue(
	overrides: Partial<Omit<Issue, "state">> & { state?: Issue["state"] } = {},
): Issue {
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
		const loop = route.find((s) => s.kind === "loop");
		if (!loop) throw new Error("loop not found");
		expect(loop.roles).toEqual(["coder", "tester"]);
	});

	it("skips the dedicated tester for documentation issues", () => {
		const route = planRoute(
			makeIssue({ title: "Fix typo in README", labels: ["documentation"] }),
		);
		const docsLoop = route.find((s) => s.kind === "loop");
		if (!docsLoop) throw new Error("docsLoop not found");
		expect(docsLoop.roles).toEqual(["coder"]);
	});

	// Regression coverage for the docsOnly heuristic bug: free-text keyword
	// matching against the issue title/body used to skip the Tester for any
	// issue that merely mentioned "docs", "typo", "wording", "comment", etc.,
	// even when it was a real code fix. Only the "documentation" label should
	// ever skip the Tester now.
	it("does NOT skip the tester when the body merely contains 'docs' (no label)", () => {
		const route = planRoute(
			makeIssue({
				title: "Update docs",
				body: "Please update the docs for the API.",
			}),
		);
		const loop = route.find((s) => s.kind === "loop");
		if (!loop) throw new Error("loop not found");
		expect(loop.roles).toEqual(["coder", "tester"]);
	});

	it("does NOT skip the tester for 'typo' in the title (no label)", () => {
		const route = planRoute(makeIssue({ title: "Fix a typo in the comment" }));
		const loop = route.find((s) => s.kind === "loop");
		if (!loop) throw new Error("loop not found");
		expect(loop.roles).toEqual(["coder", "tester"]);
	});

	it("does NOT skip the tester for 'wording' in the body (no label)", () => {
		const route = planRoute(makeRole("wording issue"));
		const loop = route.find((s) => s.kind === "loop");
		if (!loop) throw new Error("loop not found");
		expect(loop.roles).toEqual(["coder", "tester"]);
	});

	it("does NOT skip the tester based on 'README' text alone (no label)", () => {
		const route = planRoute(makeIssue({ title: "README: fix README section" }));
		const loop = route.find((s) => s.kind === "loop");
		if (!loop) throw new Error("loop not found");
		expect(loop.roles).toEqual(["coder", "tester"]);
	});

	it("does NOT skip the tester based on 'comment' text alone (no label)", () => {
		const route = planRoute(makeIssue({ title: "Fix misleading comment" }));
		const loop = route.find((s) => s.kind === "loop");
		if (!loop) throw new Error("loop not found");
		expect(loop.roles).toEqual(["coder", "tester"]);
	});

	it("is case-insensitive when classifying docs issues via the label", () => {
		const route = planRoute(
			makeIssue({
				title: "README: fix README section",
				labels: ["Documentation"],
			}),
		);
		const docsLoop = route.find((s) => s.kind === "loop");
		if (!docsLoop) throw new Error("docsLoop not found");
		expect(docsLoop.roles).toEqual(["coder"]);
	});

	it("keeps the coder+tester loop when labels contain 'bug'", () => {
		const route = planRoute(
			makeIssue({ title: "Broken widget", labels: ["bug"] }),
		);
		const loop = route.find((s) => s.kind === "loop");
		if (!loop) throw new Error("loop not found");
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

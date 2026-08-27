import type { Issue, Role } from "./types.ts";

export type StepKind = "single" | "parallel" | "loop";

export interface RouteStep {
  kind: StepKind;
  roles: Role[]; // >1 with kind "parallel" run concurrently
  label: string;
}

/**
 * The Manager (not an LLM) decides which roles run and whether sequentially or in parallel.
 * The spine is fixed by the workflow contract; the router adapts detail to the issue
 * (e.g. docs/typo issues can skip the dedicated Tester; the Coder⇄Tester loop is sequential).
 */
export function planRoute(issue: Issue): RouteStep[] {
  const labels = issue.labels.map((l) => l.toLowerCase());

  // Only a dedicated "documentation" label skips the Tester. Free-text
  // keyword matching against the issue title/body was too loose — any issue
  // that merely mentioned "comment", "docs", or "wording" (even for a real
  // code fix) would silently skip test validation. When in doubt, don't skip
  // the tester.
  const docsOnly = labels.includes("documentation");

  const steps: RouteStep[] = [
    { kind: "single", roles: ["analyzer"], label: "Analyze issue & locate root cause" },
    { kind: "single", roles: ["planner"], label: "Design the fix (plan.md)" },
    // GATE 2 happens here, in the orchestrator.
    { kind: "loop", roles: docsOnly ? ["coder"] : ["coder", "tester"], label: "Implement & validate" },
    { kind: "single", roles: ["reviewer"], label: "Review the final diff" },
    // GATE 3 happens here.
    { kind: "single", roles: ["pr"], label: "Push branch & open PR" },
  ];
  return steps;
}

/** How many Coder⇄Tester iterations the loop may run before giving up. */
export const MAX_IMPL_ITERATIONS = 3;

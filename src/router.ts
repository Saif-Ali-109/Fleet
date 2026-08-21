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
  const text = `${issue.title}\n${issue.body}`.toLowerCase();
  const labels = issue.labels.map((l) => l.toLowerCase());

  const docsOnly =
    labels.includes("documentation") ||
    /\b(typo|readme|docs?|comment|wording)\b/.test(text);

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

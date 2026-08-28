import type { Issue, Plan } from "../types.ts";

/**
 * Build a factual git commit message from the approved plan's approach line,
 * e.g. `plan.approach` "Validate the range before emitting an event" →
 * `fix: validate the range before emitting an event`.
 *
 * Rule: commit messages are factual and NEVER reference the issue number —
 * `Closes #N` belongs only in the PR body (merge-time close). Throws when the
 * plan has no approach text, so the caller surfaces a clear phase failure.
 */
export function commitMessageFor(plan: Plan, issue: Issue): string {
	const text = (plan.approach ?? "").trim();
	if (!text) {
		throw new Error(
			`cannot build a factual commit message for issue #${issue.number}: plan.approach is empty`,
		);
	}
	const firstLine = text.split("\n")[0] as string;
	// Drop a leading imperative ("Fix", "Fixes", …) so the message reads
	// "fix: validate …" instead of "fix: Fix validate …".
	const stripped = firstLine.replace(/^\s*(?:fix(?:es)?)\s*[:.-]?\s+/i, "");
	let body = (stripped.charAt(0).toLowerCase() + stripped.slice(1)).trim();
	body = body.replace(/[.\s]+$/, "");
	const MAX_SUBJECT = 72;
	const prefix = "fix: ";
	if (prefix.length + body.length > MAX_SUBJECT) {
		body = `${body.slice(0, MAX_SUBJECT - prefix.length - 1)}…`;
	}
	return `${prefix}${body}`;
}

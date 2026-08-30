// Policy enforcement point evaluator (spec §9.6, plan-sor.md C6.2).
// Pure module: no env, no DB, no model calls.

import type {
	ArgumentMatcher,
	PolicyDocument,
	RulePredicate,
} from "../sor/kernel/types.ts";

export type PolicyDecision =
	| { allowed: true; decision: "ALLOW"; reason: "allowed" }
	| { allowed: false; decision: "DENY"; reason: string };

export type PepDecision = PolicyDecision;

/** Effective tool set = capability ceiling ∩ policy grant (P-I1). */
export interface EffectiveToolSet {
	allowedTools: readonly string[];
	mcpAllow: readonly string[];
}

/** Value lookup at a dot-path inside the parsed tool argument object. */
function atPath(input: unknown, path: string): unknown {
	let cur = input;
	for (const part of path.split(".")) {
		if (cur === null || cur === undefined) return undefined;
		if (Array.isArray(cur)) {
			const idx = Number(part);
			if (Number.isNaN(idx)) return undefined;
			cur = cur[idx];
		} else if (typeof cur === "object") {
			cur = (cur as Record<string, unknown>)[part];
		} else {
			return undefined;
		}
	}
	return cur;
}

function stringifyValue(v: unknown): string {
	if (v === null || v === undefined) return "";
	if (typeof v === "string") return v;
	if (typeof v === "object") return JSON.stringify(v);
	return String(v);
}

/** `true` when the matcher's condition holds against the parsed input. */
export function evaluateMatcher(
	matcher: ArgumentMatcher,
	input: unknown,
): boolean {
	const value = atPath(input, matcher.path);
	if (matcher.oneOf !== undefined) {
		return matcher.oneOf.some((candidate) => candidate === value);
	}
	if (matcher.notOneOf !== undefined) {
		return !matcher.notOneOf.some((candidate) => candidate === value);
	}
	if (matcher.match !== undefined) {
		try {
			return new RegExp(matcher.match).test(stringifyValue(value));
		} catch {
			return false;
		}
	}
	return false;
}

/** The PEP: tool executes iff granted AND all applicable rules are satisfied (§9.3). */
export function evaluateToolCall(
	toolName: string,
	input: unknown,
	effective: EffectiveToolSet,
	rules: Record<string, RulePredicate[]>,
): PolicyDecision {
	const granted =
		effective.allowedTools.includes(toolName) ||
		effective.mcpAllow.includes(toolName);
	if (!granted) {
		return {
			allowed: false,
			decision: "DENY",
			reason: `unknown tool: ${toolName}`,
		};
	}
	for (const rule of rules[toolName] ?? []) {
		const matched = evaluateMatcher(rule.when, input);
		if (rule.op === "deny" && matched) {
			return {
				allowed: false,
				decision: "DENY",
				reason: rule.reason ?? `denied by rule on ${toolName}`,
			};
		}
		if (rule.op === "require" && !matched) {
			return {
				allowed: false,
				decision: "DENY",
				reason: rule.reason ?? `require rule unmet on ${toolName}`,
			};
		}
	}
	return { allowed: true, decision: "ALLOW", reason: "allowed" };
}

/** Ceiling ∩ grant (P-I1): a def tool only survives if the policy grants it. */
export function computeEffectiveTools(
	ceiling: {
		tools: readonly string[];
		mcpAllow: readonly string[];
	},
	doc: PolicyDocument,
): EffectiveToolSet {
	return {
		allowedTools: ceiling.tools.filter((t) => doc.allowedTools.includes(t)),
		mcpAllow: ceiling.mcpAllow.filter((t) => doc.mcpAllow.includes(t)),
	};
}
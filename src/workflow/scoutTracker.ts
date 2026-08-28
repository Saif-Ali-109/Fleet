import type { Role } from "../types.ts";

/** Log-only tracker for scout subagent invocations seen in worker NDJSON traces. */
export class ScoutTracker {
	total = 0;
	private perParent: Map<Role, number> = new Map();

	observe(parent: Role, ev: Record<string, unknown>): boolean {
		try {
			const part = isObj(ev.part) ? ev.part : null;
			const message = isObj(ev.message) ? ev.message : null;

			let tool: string | null = null;
			let input: unknown;
			if (
				part &&
				(part.type === "tool_call" ||
					part.type === "tool" ||
					typeof part.tool === "string")
			) {
				const state = isObj(part.state) ? part.state : null;
				tool =
					typeof part.tool === "string"
						? part.tool
						: typeof part.tool_name === "string"
							? part.tool_name
							: null;
				input =
					state && state.input !== undefined
						? state.input
						: (part.input ?? null);
			} else if (message && typeof message.tool === "string") {
				tool = message.tool;
				input = message.input ?? null;
			} else if (message && Array.isArray(message.toolCalls)) {
				const first = message.toolCalls[0];
				if (isObj(first)) {
					const state = isObj(first.state) ? first.state : null;
					tool = typeof first.tool === "string" ? first.tool : null;
					input =
						state && state.input !== undefined
							? state.input
							: (first.input ?? null);
				}
			}

			if (tool !== "task") return false;
			let text: string;
			try {
				text = JSON.stringify(input ?? "");
			} catch {
				return false;
			}
			if (!text.toLowerCase().includes("scout")) return false;

			this.total += 1;
			this.perParent.set(parent, (this.perParent.get(parent) ?? 0) + 1);
			return true;
		} catch {
			return false;
		}
	}

	countFor(parent: Role): number {
		return this.perParent.get(parent) ?? 0;
	}

	summary(): string {
		const parts: string[] = [];
		for (const [role, count] of this.perParent) {
			if (count > 0) parts.push(`${role}=${count}`);
		}
		if (parts.length === 0) return "scout calls: 0";
		return `scout calls: ${this.total} total (${parts.join(", ")})`;
	}
}

function isObj(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

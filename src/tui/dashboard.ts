import type { AgentResult, ProviderName, Role } from "../types.ts";

type PhaseName =
	| "idle"
	| "analyze"
	| "plan"
	| "implement"
	| "review"
	| "pr"
	| "paused"
	| "done"
	| "aborted"
	| "failed";

export interface AgentStatus {
	role: Role;
	state: "pending" | "running" | "done" | "failed";
	model: string;
	sessionID?: string;
	tokens?: AgentResult["tokens"];
	costUsd?: number;
	calls?: { tools: number; models: number; skills: number };
	startedAt?: number;
	endedAt?: number;
	error?: string;
}

export interface DashboardState {
	runId: string;
	repo: string;
	issue: number;
	phase: PhaseName;
	agents: Record<Role, AgentStatus>;
	loopIteration: number;
	prUrl?: string;
	backend?: ProviderName;
	totals?: {
		tools: number;
		models: number;
		skills: number;
		costUsd: number;
		tokens: number;
	};
	quotaNotice?: string;
}

const ROLES: Role[] = [
	"analyzer",
	"planner",
	"coder",
	"tester",
	"reviewer",
	"pr",
];

export function newDashboardState(
	runId: string,
	repo: string,
	issue: number,
	backend: ProviderName = "gemini",
): DashboardState {
	const agents = Object.fromEntries(
		ROLES.map((r) => [r, { role: r, state: "pending" as const, model: "" }]),
	) as Record<Role, AgentStatus>;
	return {
		runId,
		repo,
		issue,
		phase: "idle",
		agents,
		loopIteration: 1,
		backend,
	};
}

const BAR_W = 20;
const spinner = (state: string) =>
	state === "running"
		? "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏".charAt(Math.floor(Date.now() / 90) % 10)
		: " ";

function renderBar(pct: number): string {
	const filled = Math.round(pct * BAR_W);
	return "█".repeat(filled) + "░".repeat(BAR_W - filled);
}

/** Render the live dashboard as one ANSI-framed block (dimmed: no erase trickery). */
export function renderDashboard(d: DashboardState): string {
	const rows = ROLES.map((r) => {
		const a = d.agents[r];
		const model = a?.model?.split("/").pop() ?? "";
		const state = a?.state ?? "pending";
		const sp = spinner(state);
		const bar =
			state === "done"
				? renderBar(1)
				: state === "running"
					? renderBar(0.5)
					: renderBar(0);
		const meta =
			a.state === "done" && a.costUsd !== undefined && a.tokens
				? ` $${a.costUsd.toFixed(3)} · ${a.tokens.total.toLocaleString()} tok (in ${a.tokens.input.toLocaleString()} / out ${a.tokens.output.toLocaleString()}${a.tokens.reasoning ? ` / r:${a.tokens.reasoning.toLocaleString()}` : ""} / cached ${a.tokens.cached.toLocaleString()})`
				: a.state === "done" && a.costUsd !== undefined
					? ` $${a.costUsd.toFixed(3)} ${a.tokens?.total?.toLocaleString() ?? ""} tok`
					: a.state === "failed"
						? ` ✗ ${a.error ?? "failed"}`
						: ` ${model}`;
		const flag =
			a.state === "done"
				? "✓"
				: a.state === "failed"
					? "✗"
					: a.state === "running"
						? "▸"
						: "·";
		return `  ${flag} ${r.padEnd(9)} [${bar}] ${sp}${meta}`;
	});

	const phasePct =
		d.phase === "done"
			? 1
			: d.phase === "aborted" || d.phase === "failed"
				? 0
				: 0.5;

	const totalsParts: string[] = [];
	if (d.totals) {
		if (d.totals.tools) totalsParts.push(`\u2699${d.totals.tools}`);
		if (d.totals.models) totalsParts.push(`\ud83e\udd16${d.totals.models}`);
		if (d.totals.skills) totalsParts.push(`\ud83d\udcda${d.totals.skills}`);
		if (d.totals.costUsd) totalsParts.push(`$${d.totals.costUsd.toFixed(4)}`);
		if (d.totals.tokens)
			totalsParts.push(`${d.totals.tokens.toLocaleString()} tok`);
	}
	const totalsLine = totalsParts.length
		? `\n\u2502 ${totalsParts.join(" \u00b7 ")}`
		: "";

	const quotaLine = d.quotaNotice
		? `\n\u2502 ${d.quotaNotice.toLowerCase().includes("exhausted") ? "⚠⚠" : "⚠"} ${d.quotaNotice}`
		: "";

	return [
		`\n┌─ Fleet ─ run ${d.runId} ─ ${d.repo}#${d.issue} ─ ${d.backend ?? "gemini"} ────────┐`,
		`│ phase: ${(d.phase === "paused" ? "⏸ paused" : d.phase).padEnd(12)} loop: ${d.loopIteration}  [${renderBar(phasePct)}]`,
		...rows.map((r) => `│${r}`),
		totalsLine,
		quotaLine,
		`└──────────────────────────────────────────────────────────────┘`,
	]
		.filter(Boolean)
		.join("\n");
}

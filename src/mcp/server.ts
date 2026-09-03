import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { db, pool } from "../db/client.ts";

const server = new Server(
	{ name: "fleet-mcp", version: "1.0.0" },
	{ capabilities: { tools: {} } },
);

const CREATE_RUN_SCHEMA = {
	type: "object",
	properties: {
		repo: { type: "string" },
		issue_number: { type: "number" },
		backend: { type: "string" },
	},
	required: ["repo", "issue_number", "backend"],
} as const;

const UPDATE_RUN_STATUS_SCHEMA = {
	type: "object",
	properties: {
		run_id: { type: "string" },
		phase: { type: "string" },
		status: { type: "string" },
		iteration: { type: "number" },
	},
	required: ["run_id", "phase", "status", "iteration"],
} as const;

const LOG_AGENT_ACTION_SCHEMA = {
	type: "object",
	properties: {
		run_id: { type: "string" },
		role: { type: "string" },
		model: { type: "string" },
		ok: { type: "boolean" },
		text: { type: "string" },
		tokens: { type: "object" },
		cost: { type: "number" },
		trace_path: { type: "string" },
		started_at: { type: "string" },
		ended_at: { type: "string" },
		attempts: { type: "array" },
	},
	required: [
		"run_id",
		"role",
		"model",
		"ok",
		"text",
		"tokens",
		"cost",
		"trace_path",
		"started_at",
		"ended_at",
		"attempts",
	],
} as const;

const FINALIZE_RUN_SCHEMA = {
	type: "object",
	properties: {
		run_id: { type: "string" },
		pr_url: { type: "string" },
		total_cost: { type: "number" },
		gate_status: { type: "string" },
		status: { type: "string" },
		iterations_used: { type: "number" },
	},
	required: ["run_id", "pr_url", "total_cost", "gate_status", "status"],
} as const;

const QUERY_COST_BY_ROLE_SCHEMA = {
	type: "object",
	properties: {
		from_date: { type: "string" },
		to_date: { type: "string" },
	},
	required: ["from_date", "to_date"],
} as const;

function reqString(
	args: Record<string, unknown>,
	key: string,
	tool: string,
): string {
	const value = args[key];
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(
			`Tool ${tool}: missing or invalid string argument '${key}'`,
		);
	}
	return value;
}

function reqNullableString(
	args: Record<string, unknown>,
	key: string,
	tool: string,
): string | null {
	const value = args[key];
	if (value === null) {
		return null;
	}
	if (typeof value !== "string") {
		throw new Error(
			`Tool ${tool}: missing or invalid string argument '${key}'`,
		);
	}
	return value;
}

function reqNumber(
	args: Record<string, unknown>,
	key: string,
	tool: string,
): number {
	const value = args[key];
	if (typeof value !== "number" || Number.isNaN(value)) {
		throw new Error(
			`Tool ${tool}: missing or invalid number argument '${key}'`,
		);
	}
	return value;
}

function optNumber(
	args: Record<string, unknown>,
	key: string,
	tool: string,
): number | undefined {
	const value = args[key];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "number" || Number.isNaN(value)) {
		throw new Error(`Tool ${tool}: invalid number argument '${key}'`);
	}
	return value;
}

function reqBoolean(
	args: Record<string, unknown>,
	key: string,
	tool: string,
): boolean {
	const value = args[key];
	if (typeof value !== "boolean") {
		throw new Error(
			`Tool ${tool}: missing or invalid boolean argument '${key}'`,
		);
	}
	return value;
}

function reqRecord(
	args: Record<string, unknown>,
	key: string,
	tool: string,
): Record<string, unknown> {
	const value = args[key];
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(
			`Tool ${tool}: missing or invalid object argument '${key}'`,
		);
	}
	return value as Record<string, unknown>;
}

function reqArray(
	args: Record<string, unknown>,
	key: string,
	tool: string,
): unknown[] {
	const value = args[key];
	if (!Array.isArray(value)) {
		throw new Error(`Tool ${tool}: missing or invalid array argument '${key}'`);
	}
	return value;
}

function reqDate(
	args: Record<string, unknown>,
	key: string,
	tool: string,
): Date {
	const value = args[key];
	if (typeof value !== "string") {
		throw new Error(`Tool ${tool}: missing or invalid date argument '${key}'`);
	}
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		throw new Error(`Tool ${tool}: invalid date value for argument '${key}'`);
	}
	return date;
}

function toJsonbParam(v: unknown): unknown {
	if (v === undefined || v === null) return null;
	if (
		typeof v === "string" ||
		typeof v === "number" ||
		typeof v === "boolean"
	) {
		return JSON.stringify(v);
	}
	return v;
}

interface CostByRoleRow {
	role: string;
	model: string;
	total_cost: number;
	count: number;
}

async function createRun(
	args: Record<string, unknown>,
): Promise<{ run_id: string; created_at: string }> {
	const run_id = await db.createRun({
		repo: reqString(args, "repo", "create_run"),
		issue_number: reqNumber(args, "issue_number", "create_run"),
		backend: reqString(args, "backend", "create_run"),
	});
	return { run_id, created_at: new Date().toISOString() };
}

async function updateRunStatus(
	args: Record<string, unknown>,
): Promise<{ updated: boolean }> {
	const updated = await db.updateRunStatus({
		run_id: reqString(args, "run_id", "update_run_status"),
		phase: reqString(args, "phase", "update_run_status"),
		status: reqString(args, "status", "update_run_status"),
		iteration: reqNumber(args, "iteration", "update_run_status"),
	});
	return { updated };
}

async function logAgentAction(
	args: Record<string, unknown>,
): Promise<{ action_id: string }> {
	const action_id = await db.logAgentAction({
		run_id: reqString(args, "run_id", "log_agent_action"),
		role: reqString(args, "role", "log_agent_action"),
		model: reqString(args, "model", "log_agent_action"),
		ok: reqBoolean(args, "ok", "log_agent_action"),
		text: reqString(args, "text", "log_agent_action"),
		tokens: reqRecord(args, "tokens", "log_agent_action"),
		cost_usd: reqNumber(args, "cost", "log_agent_action"),
		trace_path: reqString(args, "trace_path", "log_agent_action"),
		started_at: reqDate(args, "started_at", "log_agent_action"),
		ended_at: reqDate(args, "ended_at", "log_agent_action"),
		attempts: reqArray(args, "attempts", "log_agent_action"),
	});
	return { action_id };
}

async function finalizeRun(
	args: Record<string, unknown>,
): Promise<{ finalized: boolean }> {
	const finalized = await db.finalizeRun({
		run_id: reqString(args, "run_id", "finalize_run"),
		pr_url: reqNullableString(args, "pr_url", "finalize_run"),
		total_cost: reqNumber(args, "total_cost", "finalize_run"),
		gate_status: toJsonbParam(
			reqString(args, "gate_status", "finalize_run"),
		) as string,
		status: reqString(args, "status", "finalize_run"),
		iterationsUsed: optNumber(args, "iterations_used", "finalize_run"),
	});
	return { finalized };
}

async function queryCostByRole(
	args: Record<string, unknown>,
): Promise<CostByRoleRow[]> {
	const fromDate = reqDate(
		args,
		"from_date",
		"query_cost_by_role",
	).toISOString();
	const toDate = reqDate(args, "to_date", "query_cost_by_role").toISOString();
	const result = await pool.query<CostByRoleRow>(
		`SELECT role, model, SUM(cost_usd)::float AS total_cost, COUNT(*)::int AS count
FROM agent_actions
WHERE started_at >= $1 AND started_at <= $2
GROUP BY role, model`,
		[fromDate, toDate],
	);
	return result.rows;
}

async function handleToolCall(
	name: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	switch (name) {
		case "create_run":
			return createRun(args);
		case "update_run_status":
			return updateRunStatus(args);
		case "log_agent_action":
			return logAgentAction(args);
		case "finalize_run":
			return finalizeRun(args);
		case "query_cost_by_role":
			return queryCostByRole(args);
		default:
			throw new Error(`Unknown tool: ${name}`);
	}
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [
		{
			name: "create_run",
			description: "Create a run record (idempotent per repo+issue).",
			inputSchema: CREATE_RUN_SCHEMA,
		},
		{
			name: "update_run_status",
			description: "Record phase/iteration status for a run.",
			inputSchema: UPDATE_RUN_STATUS_SCHEMA,
		},
		{
			name: "log_agent_action",
			description: "Log a completed agent action for a run.",
			inputSchema: LOG_AGENT_ACTION_SCHEMA,
		},
		{
			name: "finalize_run",
			description: "Mark a run complete with PR URL and cost.",
			inputSchema: FINALIZE_RUN_SCHEMA,
		},
		{
			name: "query_cost_by_role",
			description: "Aggregate cost and count by role/model over a date range.",
			inputSchema: QUERY_COST_BY_ROLE_SCHEMA,
		},
	],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
	const { name, arguments: args } = request.params;
	try {
		const result = await handleToolCall(name, args ?? {});
		return {
			content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : "Unknown error";
		return {
			isError: true,
			content: [
				{ type: "text", text: JSON.stringify({ error: msg }, null, 2) },
			],
		};
	}
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	await server.close().catch(() => {});
	await db.close().catch(() => {});
}

async function main() {
	const transport = new StdioServerTransport();
	await server.connect(transport);
}
void main();

process.stdin.on("end", () => {
	void shutdown();
});
process.once("SIGINT", () => {
	void shutdown();
});
process.once("SIGTERM", () => {
	void shutdown();
});

export { handleToolCall, toJsonbParam };

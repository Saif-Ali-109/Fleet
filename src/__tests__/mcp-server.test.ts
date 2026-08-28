import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../db/client.ts";
import { handleToolCall, toJsonbParam } from "../mcp/server.ts";

const REPO = "test/mcp";

async function cleanup(): Promise<void> {
	await pool.query(
		`DELETE FROM agent_actions
     WHERE run_id IN (SELECT run_id FROM run_outcomes WHERE repo = $1)`,
		[REPO],
	);
	await pool.query("DELETE FROM run_outcomes WHERE repo = $1", [REPO]);
}

describe("MCP toJsonbParam jsonb-safety", () => {
	it("wraps primitive gate_status values as JSON-encoded scalars", () => {
		expect(toJsonbParam("pass")).toBe('"pass"');
		expect(toJsonbParam("fail")).toBe('"fail"');
		expect(toJsonbParam(42)).toBe("42");
		expect(toJsonbParam(3.14)).toBe("3.14");
		expect(toJsonbParam(true)).toBe("true");
		expect(toJsonbParam(false)).toBe("false");
	});

	it("round-trips wrapped primitives back to the original value", () => {
		expect(JSON.parse(toJsonbParam("pass") as string)).toBe("pass");
		expect(JSON.parse(toJsonbParam(7) as string)).toBe(7);
		expect(JSON.parse(toJsonbParam(true) as string)).toBe(true);
	});

	it("passes objects and arrays through unchanged", () => {
		const obj = { analyze: { status: "approved", iteration: 1 } };
		const arr = [{ iteration: 2 }];
		expect(toJsonbParam(obj)).toBe(obj);
		expect(toJsonbParam(arr)).toBe(arr);
	});

	it("maps null and undefined to null", () => {
		expect(toJsonbParam(null)).toBeNull();
		expect(toJsonbParam(undefined)).toBeNull();
	});
});

describe("MCP server handleToolCall integration", () => {
	beforeAll(async () => {
		await cleanup();
	});

	afterEach(async () => {
		await cleanup();
	});

	afterAll(async () => {
		await cleanup();
		await pool.end();
	});

	it("create_run returns a valid UUID run_id and ISO created_at", async () => {
		const result = (await handleToolCall("create_run", {
			repo: REPO,
			issue_number: 1001,
			backend: "opencode",
		})) as { run_id: string; created_at: string };

		expect(result.run_id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
		expect(result.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(Number.isNaN(Date.parse(result.created_at))).toBe(false);
	});

	it("create_run is idempotent for the same repo+issue", async () => {
		const args = {
			repo: REPO,
			issue_number: 1002,
			backend: "opencode",
		};

		const first = (await handleToolCall("create_run", args)) as {
			run_id: string;
		};
		const second = (await handleToolCall("create_run", args)) as {
			run_id: string;
		};

		expect(second.run_id).toBe(first.run_id);
	});

	it("update_run_status returns { updated: true }", async () => {
		const created = (await handleToolCall("create_run", {
			repo: REPO,
			issue_number: 1003,
			backend: "opencode",
		})) as { run_id: string };

		const result = (await handleToolCall("update_run_status", {
			run_id: created.run_id,
			phase: "analyze",
			status: "running",
			iteration: 0,
		})) as { updated: boolean };

		expect(result.updated).toBe(true);
	});

	it("log_agent_action returns a valid UUID action_id", async () => {
		const created = (await handleToolCall("create_run", {
			repo: REPO,
			issue_number: 1004,
			backend: "opencode",
		})) as { run_id: string };

		const result = (await handleToolCall("log_agent_action", {
			run_id: created.run_id,
			role: "analyzer",
			model: "opencode/test-model",
			ok: true,
			text: "analysis complete",
			tokens: { input: 10, output: 5 },
			cost: 0.01,
			trace_path: `traces/${created.run_id}/analyzer.jsonl`,
			started_at: "2026-08-01T00:00:00Z",
			ended_at: "2026-08-01T00:01:00Z",
			attempts: [{ model: "test", ok: true }],
		})) as { action_id: string };

		expect(result.action_id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
	});

	it("finalize_run returns { finalized: true } and persists the real status", async () => {
		const created = (await handleToolCall("create_run", {
			repo: REPO,
			issue_number: 1005,
			backend: "opencode",
		})) as { run_id: string };

		const result = (await handleToolCall("finalize_run", {
			run_id: created.run_id,
			pr_url: "https://github.com/x/y/pull/1",
			total_cost: 0.05,
			gate_status: "{}",
			status: "completed",
		})) as { finalized: boolean };

		expect(result.finalized).toBe(true);
		const row = await pool.query<{ status: string }>(
			"SELECT status FROM run_outcomes WHERE run_id = $1",
			[created.run_id],
		);
		expect(row.rows[0]?.status).toBe("completed");
	});

	it("finalize_run persists iterations_used when provided", async () => {
		const created = (await handleToolCall("create_run", {
			repo: REPO,
			issue_number: 1010,
			backend: "opencode",
		})) as { run_id: string };

		const result = (await handleToolCall("finalize_run", {
			run_id: created.run_id,
			pr_url: null,
			total_cost: 0.05,
			gate_status: "{}",
			status: "completed",
			iterations_used: 7,
		})) as { finalized: boolean };

		expect(result.finalized).toBe(true);
		const row = await pool.query<{ iterations_used: number }>(
			"SELECT iterations_used FROM run_outcomes WHERE run_id = $1",
			[created.run_id],
		);
		expect(row.rows[0]?.iterations_used).toBe(7);
	});

	it("finalize_run derives iterations_used from gate_status when not provided", async () => {
		const created = (await handleToolCall("create_run", {
			repo: REPO,
			issue_number: 1011,
			backend: "opencode",
		})) as { run_id: string };

		await handleToolCall("update_run_status", {
			run_id: created.run_id,
			phase: "done",
			status: "completed",
			iteration: 3,
		});

		const result = (await handleToolCall("finalize_run", {
			run_id: created.run_id,
			pr_url: null,
			total_cost: 0.05,
			gate_status: "{}",
			status: "completed",
		})) as { finalized: boolean };

		expect(result.finalized).toBe(true);
		const row = await pool.query<{ iterations_used: number }>(
			"SELECT iterations_used FROM run_outcomes WHERE run_id = $1",
			[created.run_id],
		);
		expect(row.rows[0]?.iterations_used).toBe(3);
	});

	it("finalize_run stores a primitive gate_status as a jsonb scalar instead of failing", async () => {
		const created = (await handleToolCall("create_run", {
			repo: REPO,
			issue_number: 1013,
			backend: "opencode",
		})) as { run_id: string };

		const result = (await handleToolCall("finalize_run", {
			run_id: created.run_id,
			pr_url: null,
			total_cost: 0.05,
			gate_status: "pass",
			status: "completed",
		})) as { finalized: boolean };

		expect(result.finalized).toBe(true);
		const row = await pool.query<{ gate_status: unknown }>(
			"SELECT gate_status FROM run_outcomes WHERE run_id = $1",
			[created.run_id],
		);
		expect(row.rows[0]?.gate_status).toBe("pass");
	});

	it("finalize_run returns finalized:false when the run does not exist", async () => {
		const result = (await handleToolCall("finalize_run", {
			run_id: randomUUID(),
			pr_url: null,
			total_cost: 0,
			gate_status: "{}",
			status: "completed",
		})) as { finalized: boolean };

		expect(result.finalized).toBe(false);
	});

	it("update_run_status merges gate_status phases atomically", async () => {
		const created = (await handleToolCall("create_run", {
			repo: REPO,
			issue_number: 1012,
			backend: "opencode",
		})) as { run_id: string };

		await handleToolCall("update_run_status", {
			run_id: created.run_id,
			phase: "analyze",
			status: "running",
			iteration: 0,
		});
		await handleToolCall("update_run_status", {
			run_id: created.run_id,
			phase: "plan",
			status: "approved",
			iteration: 2,
		});
		await handleToolCall("update_run_status", {
			run_id: created.run_id,
			phase: "analyze",
			status: "approved",
			iteration: 1,
		});

		const row = await pool.query<{
			gate_status: Record<string, { status: string; iteration: number }>;
		}>("SELECT gate_status FROM run_outcomes WHERE run_id = $1", [
			created.run_id,
		]);
		expect(row.rows[0]?.gate_status).toEqual({
			analyze: { status: "approved", iteration: 1 },
			plan: { status: "approved", iteration: 2 },
		});
	});

	it("update_run_status returns updated:false for a nonexistent run", async () => {
		const result = (await handleToolCall("update_run_status", {
			run_id: randomUUID(),
			phase: "analyze",
			status: "running",
			iteration: 0,
		})) as { updated: boolean };

		expect(result.updated).toBe(false);
	});

	it("query_cost_by_role returns an array with expected fields", async () => {
		const created = (await handleToolCall("create_run", {
			repo: REPO,
			issue_number: 1006,
			backend: "opencode",
		})) as { run_id: string };

		await handleToolCall("log_agent_action", {
			run_id: created.run_id,
			role: "analyzer",
			model: "opencode/test-analyzer",
			ok: true,
			text: "a1",
			tokens: { input: 10, output: 5 },
			cost: 0.01,
			trace_path: "traces/a.jsonl",
			started_at: "2026-08-01T00:00:00Z",
			ended_at: "2026-08-01T00:01:00Z",
			attempts: [{ model: "opencode/test-analyzer", ok: true }],
		});
		await handleToolCall("log_agent_action", {
			run_id: created.run_id,
			role: "planner",
			model: "opencode/test-planner",
			ok: true,
			text: "p1",
			tokens: { input: 20, output: 5 },
			cost: 0.02,
			trace_path: "traces/p.jsonl",
			started_at: "2026-08-01T00:02:00Z",
			ended_at: "2026-08-01T00:03:00Z",
			attempts: [{ model: "opencode/test-planner", ok: true }],
		});

		const result = (await handleToolCall("query_cost_by_role", {
			from_date: "2026-01-01T00:00:00Z",
			to_date: "2026-12-31T00:00:00Z",
		})) as Array<{
			role: string;
			model: string;
			total_cost: number;
			count: number;
		}>;

		expect(Array.isArray(result)).toBe(true);
		expect(result.length).toBeGreaterThanOrEqual(2);

		const analyzerRow = result.find(
			(r) => r.role === "analyzer" && r.model === "opencode/test-analyzer",
		);
		expect(analyzerRow).toBeDefined();
		expect(analyzerRow?.model).toBe("opencode/test-analyzer");
		expect(analyzerRow?.count).toBe(1);
		expect(analyzerRow?.total_cost).toBeCloseTo(0.01, 5);

		for (const row of result) {
			expect(typeof row.role).toBe("string");
			expect(typeof row.model).toBe("string");
			expect(typeof row.total_cost).toBe("number");
			expect(typeof row.count).toBe("number");
		}
	});

	it("unknown tool rejects with an error containing 'Unknown tool'", async () => {
		await expect(handleToolCall("nonexistent", {})).rejects.toThrow(
			"Unknown tool",
		);
	});

	it("query_cost_by_role returns rows only within the date range", async () => {
		const created = (await handleToolCall("create_run", {
			repo: REPO,
			issue_number: 1007,
			backend: "opencode",
		})) as { run_id: string };

		await handleToolCall("log_agent_action", {
			run_id: created.run_id,
			role: "reviewer",
			model: "opencode/test-reviewer",
			ok: true,
			text: "r1",
			tokens: { input: 5, output: 5 },
			cost: 0.03,
			trace_path: "traces/r.jsonl",
			started_at: "2020-01-01T00:00:00Z",
			ended_at: "2020-01-01T00:01:00Z",
			attempts: [{ model: "opencode/test-reviewer", ok: true }],
		});

		const limited = (await handleToolCall("query_cost_by_role", {
			from_date: "2026-08-01T00:00:00Z",
			to_date: "2026-08-01T00:01:00Z",
		})) as Array<{ role: string; count: number }>;

		const reviewer2020 = limited.find((r) => r.role === "reviewer");
		expect(reviewer2020).toBeUndefined();

		const wider = (await handleToolCall("query_cost_by_role", {
			from_date: "2019-01-01T00:00:00Z",
			to_date: "2021-01-01T00:00:00Z",
		})) as Array<{ role: string; count: number }>;

		const reviewer2020Wide = wider.find((r) => r.role === "reviewer");
		expect(reviewer2020Wide).toBeDefined();
		expect(reviewer2020Wide?.count).toBe(1);
	});
});

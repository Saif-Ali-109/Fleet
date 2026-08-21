import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { db, pool } from "../db/client.ts";
import {
  costPerRole,
  costPerBackend,
  costPerIteration,
  topFailingRoles,
} from "../analytics/queries.ts";
import { generateReport } from "../analytics/report.ts";

const REPO = "test/analytics";
const FROM = "2000-01-01";
const TO = "2099-12-31";

async function seedRun(
  backend: string,
  iterations: number,
  status: string,
  totalCost: number,
  startedAt: string
): Promise<string> {
  const runId = randomUUID();
  await pool.query(
    `INSERT INTO run_outcomes (
      run_id, repo, issue_number, issue_title, status, total_cost_usd,
      iterations_used, started_at, completed_at, gate_status, backend
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      runId,
      REPO,
      Math.floor(Math.random() * 100000),
      "analytics test",
      status,
      totalCost,
      iterations,
      new Date(startedAt),
      new Date(startedAt),
      "{}",
      backend,
    ]
  );
  return runId;
}

async function seedAction(
  runId: string,
  role: string,
  model: string,
  ok: boolean,
  cost: number
): Promise<void> {
  const started = new Date();
  await db.logAgentAction({
    run_id: runId,
    role,
    model,
    ok,
    text: "analytics test action",
    tokens: { input: 10, output: 10, total: 20 },
    cost_usd: cost,
    trace_path: "analytics-test.jsonl",
    started_at: started,
    ended_at: started,
    attempts: [],
  });
}

beforeAll(async () => {
  const runA = await seedRun("opencode", 1, "completed", 1.0, "2026-01-01T00:00:00Z");
  await seedAction(runA, "analyzer", "deepseek-v4", true, 0.5);
  await seedAction(runA, "coder", "laguna", true, 0.5);

  const runB = await seedRun("claude", 2, "completed", 2.0, "2026-01-02T00:00:00Z");
  await seedAction(runB, "analyzer", "deepseek-v4", true, 1.0);
  await seedAction(runB, "coder", "laguna", true, 1.0);

  const runC = await seedRun("codex", 3, "failed", 3.0, "2026-01-03T00:00:00Z");
  await seedAction(runC, "coder", "laguna", false, 1.0);
  await seedAction(runC, "tester", "laguna", true, 2.0);
});

afterAll(async () => {
  await pool.query("DELETE FROM agent_actions WHERE run_id IN (SELECT run_id FROM run_outcomes WHERE repo = $1)", [REPO]);
  await pool.query("DELETE FROM run_outcomes WHERE repo = $1", [REPO]);
  await db.close();
});

describe("analytics queries", () => {
  it("costPerRole aggregates runs, cost, and success", async () => {
    const rows = await costPerRole(FROM, TO, REPO);
    const analyzer = rows.find((r) => r.role === "analyzer");
    expect(analyzer).toBeDefined();
    expect(analyzer?.model).toBe("deepseek-v4");
    expect(analyzer?.count).toBe(2);
    expect(analyzer?.total_cost_usd).toBeCloseTo(1.5, 5);
    expect(analyzer?.avg_cost_per_run).toBeCloseTo(0.75, 5);
    expect(analyzer?.success_rate).toBe(100);

    const coder = rows.find((r) => r.role === "coder" && r.model === "laguna");
    expect(coder?.count).toBe(3);
    expect(coder?.total_cost_usd).toBeCloseTo(2.5, 5);
    expect(coder?.success_rate).toBeCloseTo(100 * (2 / 3), 5);
  });

  it("costPerBackend joins run_outcomes for backend", async () => {
    const rows = await costPerBackend(FROM, TO, REPO);
    const opencode = rows.find((r) => r.backend === "opencode");
    expect(opencode).toBeDefined();
    expect(opencode?.count).toBe(2);
    expect(opencode?.total_cost_usd).toBeCloseTo(1.0, 5);

    const codex = rows.find((r) => r.backend === "codex");
    expect(codex?.success_rate).toBeCloseTo(100 * (1 / 2), 5);
  });

  it("costPerIteration groups by iterations_used", async () => {
    const rows = await costPerIteration(FROM, TO, REPO);
    const one = rows.find((r) => r.iteration === 1);
    expect(one).toBeDefined();
    expect(one?.count).toBe(1);
    expect(one?.total_cost_usd).toBeCloseTo(1.0, 5);

    const three = rows.find((r) => r.iteration === 3);
    expect(three?.success_rate).toBe(0);
  });

  it("topFailingRoles lists failing roles by failure count", async () => {
    const rows = await topFailingRoles(FROM, TO, REPO, 10);
    const coder = rows.find((r) => r.role === "coder");
    expect(coder?.failure_count).toBe(1);
    expect(coder?.model).toBe("laguna");
    expect(coder?.failure_rate).toBeCloseTo(100 * (1 / 3), 5);
  });

  it("includes the full `to` day (exclusive upper bound)", async () => {
    const atNoon = await seedRun("test", 4, "completed", 0.5, "2026-05-10T12:00:00Z");
    const nextDay = await seedRun("test", 5, "completed", 0.5, "2026-05-11T00:00:00Z");

    const rows = await costPerIteration("2026-05-10", "2026-05-10", REPO);
    expect(rows.find((r) => r.iteration === 4)?.count).toBe(1);
    expect(rows.find((r) => r.iteration === 5)?.count).toBeUndefined();
  });

  it("generateReport returns a markdown report", async () => {
    const report = await generateReport(FROM, TO, REPO);
    expect(report).toContain("# Analytics Report:");
    expect(report).toContain("## Cost by Role");
    expect(report).toContain("## Cost by Backend");
    expect(report).toContain("## Cost by Iteration");
    expect(report).toContain("## Top Failing Roles");
  });
});
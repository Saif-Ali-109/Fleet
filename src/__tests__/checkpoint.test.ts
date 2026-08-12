import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { db, pool } from "../db/client.js";
import { checkpoint } from "../db/checkpoint.js";

const ROLE = "coder";
const ITERATION = 1;
let runId: string;

beforeAll(async () => {
  runId = await db.createRun({
    repo: "test/checkpoint",
    issue_number: 1,
    backend: "opencode",
  });
});

afterEach(async () => {
  await pool.query(
    "DELETE FROM agent_steps WHERE run_id IN (SELECT run_id FROM run_outcomes WHERE repo = $1)",
    ["test/checkpoint"]
  );
});

describe("checkpoint", () => {
  it("startStep returns a valid UUID and creates a running row", async () => {
    const stepId = await checkpoint.startStep(runId, ROLE, ITERATION, "parse-spec");
    expect(stepId).toMatch(/^[0-9a-f-]{36}$/);
    const result = await pool.query<{ status: string }>(
      "SELECT status FROM agent_steps WHERE step_id = $1",
      [stepId]
    );
    expect(result.rows[0]?.status).toBe("running");
  });

  it("markStepSuccess sets the status to success", async () => {
    const stepId = await checkpoint.startStep(runId, ROLE, ITERATION, "edit-repo");
    await checkpoint.markStepSuccess(stepId);
    const result = await pool.query<{ status: string }>(
      "SELECT status FROM agent_steps WHERE step_id = $1",
      [stepId]
    );
    expect(result.rows[0]?.status).toBe("success");
  });

  it("getCompletedSteps returns the success step names", async () => {
    await checkpoint.startStep(runId, ROLE, ITERATION, "run-tests");
    const successId = await checkpoint.startStep(runId, ROLE, ITERATION, "commit");
    await checkpoint.markStepSuccess(successId);
    const completed = await checkpoint.getCompletedSteps(runId, ROLE, ITERATION);
    expect(completed).toContain("commit");
    expect(completed).not.toContain("run-tests");
  });

  it("getLastFailedStep returns the most recent failed step name", async () => {
    const failedId = await checkpoint.startStep(runId, ROLE, ITERATION, "verify-diff");
    await checkpoint.markStepFailed(failedId, "boom");
    const failed = await checkpoint.getLastFailedStep(runId, ROLE);
    expect(failed).toBe("verify-diff");
  });

  it("getLastFailedStep returns null when nothing has failed", async () => {
    const failed = await checkpoint.getLastFailedStep(runId, ROLE);
    expect(failed).toBeNull();
  });
});
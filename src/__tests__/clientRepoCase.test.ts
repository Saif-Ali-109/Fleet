import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, pool } from "../db/client.ts";

// Repo casing is written MIXED on purpose: after the fix every write lands
// lowercase and every read matches regardless of caller casing. Cleanup uses
// lower(repo) so it also sweeps legacy mixed-case rows.
const REPO_MIXED = "Test/Case-Dup";
const REPO_LOWER = REPO_MIXED.toLowerCase();
const ISSUE = 987601;
// Simulates the historical incident shape: a pre-existing row stored under
// mixed casing that newer queries must still treat as the same repo+issue.
const LEGACY_ISSUE = 987602;

async function cleanup(): Promise<void> {
	await pool.query("DELETE FROM run_outcomes WHERE lower(repo) = $1", [
		REPO_LOWER,
	]);
}

describe("DbClient repo-slug case-insensitivity", () => {
	beforeAll(async () => {
		await cleanup();
		await pool.query(
			`INSERT INTO run_outcomes (
         repo, issue_number, issue_title, status, total_cost_usd,
         iterations_used, started_at, completed_at, gate_status, backend
       ) VALUES ($1, $2, '', 'completed', 0, 1, now(), now(), '{}', 'opencode')`,
			[REPO_MIXED, LEGACY_ISSUE],
		);
	});

	afterAll(async () => {
		await cleanup();
		await pool.end();
	});

	it("createRun twice with different casings collapses onto ONE lowercase row", async () => {
		const first = await db.createRun({
			repo: "Test/Case-Dup",
			issue_number: ISSUE,
			backend: "opencode",
		});
		const second = await db.createRun({
			repo: "TEST/CASE-DUP",
			issue_number: ISSUE,
			backend: "opencode",
		});

		expect(second).toBe(first);
		const { rows } = await pool.query<{ repo: string }>(
			"SELECT repo FROM run_outcomes WHERE lower(repo) = $1 AND issue_number = $2",
			[REPO_LOWER, ISSUE],
		);
		expect(rows.map((r) => r.repo)).toEqual([REPO_LOWER]);
	});

	it("hasCompletedRun sees a completed row regardless of query casing", async () => {
		// Row was written as `Test/Case-Dup` (legacy shape); queries use other casings.
		await expect(
			db.hasCompletedRun("TEST/CASE-DUP", LEGACY_ISSUE),
		).resolves.toBe(true);
		await expect(db.hasCompletedRun(REPO_LOWER, LEGACY_ISSUE)).resolves.toBe(
			true,
		);
		await expect(
			db.hasCompletedRun(REPO_LOWER, LEGACY_ISSUE + 1),
		).resolves.toBe(false);
	});

	it("finalizeRun hits the row created under a different casing", async () => {
		const runId = await db.createRun({
			repo: "TEST/CASE-DUP",
			issue_number: ISSUE,
			backend: "opencode",
		});
		await expect(
			db.finalizeRun({
				run_id: runId,
				pr_url: "https://github.com/test/case-dup/pull/1",
				total_cost: 0.5,
				gate_status: "{}",
				status: "completed",
				iterationsUsed: 3,
			}),
		).resolves.toBe(true);

		const finalized = await db.getRun(runId);
		expect(finalized?.status).toBe("completed");
		expect(finalized?.pr_url).toContain("/pull/1");

		// Reads keyed by repo+issue resolve the row under any casing too.
		await expect(
			db.getRunByRepoIssue("TEST/CASE-DUP", ISSUE),
		).resolves.toMatchObject({ run_id: runId });
		await expect(db.hasCompletedRun("Test/Case-Dup", ISSUE)).resolves.toBe(
			true,
		);
	});
});

// Summary report generator — builds MEMORY.md from the run_outcomes table.
// Exported as a library function (used by src/orchestrator.ts) and also runnable
// directly via `npm run generate-memory` (tsx src/db/queries/summaryReport.ts).

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../client.js";

interface RunOutcomeRow {
  repo: string;
  issue_number: number;
  issue_title: string;
  pr_url: string | null;
  total_cost_usd: number | string | null;
  completed_at: Date | null;
  status: string;
}

function formatDate(value: Date): string {
  const d = new Date(value);
  const iso = d.toISOString();
  return iso.slice(0, 10);
}

function formatCost(value: number | string | null): string {
  if (value === null || value === undefined) {
    return "0.00";
  }
  const n = typeof value === "number" ? value : Number(value);
  if (Number.isNaN(n)) {
    return "0.00";
  }
  return n.toFixed(2);
}

async function queryRunOutcomes(): Promise<RunOutcomeRow[]> {
  const result = await pool.query<RunOutcomeRow>(
    `SELECT repo, issue_number, issue_title, pr_url, total_cost_usd, completed_at, status
     FROM run_outcomes
     ORDER BY completed_at DESC
     LIMIT 100`
  );
  return result.rows;
}

function formatRunLine(row: RunOutcomeRow): string | null {
  const date = row.completed_at ? formatDate(row.completed_at) : null;
  const pr = row.pr_url ?? "(none)";
  const cost = formatCost(row.total_cost_usd);
  const datePart = date ? `${date} ` : "";
  return `- ${datePart}${row.repo}#${row.issue_number} ${row.issue_title} PR: ${pr} $${cost} [${row.status}]`;
}

/** Build the full MEMORY.md markdown from the run_outcomes table. */
export async function generateMemoryMarkdown(_rootDir: string): Promise<string> {
  const rows = await queryRunOutcomes();
  const lines = rows
    .map(formatRunLine)
    .filter((line): line is string => line !== null);

  const header = [
    "# Run log",
    "",
    `_Regenerated from the database on ${new Date().toISOString()} — do not hand-edit._`,
    "",
  ];

  return [...header, ...lines, ""].join("\n");
}

/** CLI entrypoint: writes MEMORY.md to the project root (process.cwd()). */
export async function generateMemory(rootDir = process.cwd()): Promise<string> {
  const migrationCount = await pool.query<{ count: string }>(
    "SELECT count(*) AS count FROM migrations WHERE status = 'applied'"
  );
  const applied = migrationCount.rows[0]?.count ?? "0";

  const md = await generateMemoryMarkdown(rootDir);
  const outPath = path.join(rootDir, "MEMORY.md");
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, md, "utf8");
  console.log(`[generate-memory] wrote ${outPath} (${applied} migrations applied)`);
  return outPath;
}

async function main(): Promise<void> {
  await generateMemory(process.cwd());
}

const directlyRun =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (directlyRun) {
  void main();
}
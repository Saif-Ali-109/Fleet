// Summary report generator — builds MEMORY.txt from the run_outcomes table.
// Exported as a library function (used by src/orchestrator.ts) and also runnable
// directly via `npm run generate-memory` (tsx src/db/queries/summaryReport.ts).
//
// MEMORY.txt is merged, not overwritten:
// - `generateMemoryMarkdown` builds the run-log section delimited by
//   `<!-- run-log-start -->` / `<!-- run-log-end -->` comments.
// - `generateMemory` reads any existing MEMORY.txt and replaces ONLY the block
//   between those delimiters, preserving hand-curated sections (`## Next` …).
// - If the file is missing or lacks the delimiters, it falls back to a full
//   overwrite of the regenerated markdown.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../client.ts";
import { resolveManagerPath } from "../../memory/paths.ts";

export const RUN_LOG_START = "<!-- run-log-start -->";
export const RUN_LOG_END = "<!-- run-log-end -->";

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

/**
 * Replace the run-log block in `existing` (delimited by `RUN_LOG_START` and
 * `RUN_LOG_END`, delimiters inclusive) with `newBlock` (which must itself be
 * delimiter-wrapped). Everything outside the block is preserved verbatim.
 * Returns null when `existing` lacks a valid block so callers can fall back to
 * a full overwrite.
 */
export function mergeRunLogBlock(existing: string, newBlock: string): string | null {
  const startIdx = existing.indexOf(RUN_LOG_START);
  const endIdx = existing.indexOf(RUN_LOG_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return null;
  }
  const before = existing.slice(0, startIdx);
  const after = existing.slice(endIdx + RUN_LOG_END.length);
  return before + newBlock + after;
}

/** Extract the delimiter-wrapped run-log block (delimiters inclusive) from `md`. */
function extractRunLogBlock(md: string): string {
  const startIdx = md.indexOf(RUN_LOG_START);
  const endIdx = md.indexOf(RUN_LOG_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return md;
  }
  return md.slice(startIdx, endIdx + RUN_LOG_END.length);
}

/** Build the full MEMORY.txt markdown from the run_outcomes table. */
export async function generateMemoryMarkdown(_rootDir: string): Promise<string> {
  const rows = await queryRunOutcomes();
  const lines = rows
    .map(formatRunLine)
    .filter((line): line is string => line !== null);

  const header = ["# Run log", ""];

  const block = [
    RUN_LOG_START,
    `_Regenerated from the database on ${new Date().toISOString()} — do not hand-edit._`,
    "",
    ...lines,
    RUN_LOG_END,
  ];

  return [...header, ...block, ""].join("\n");
}

/** CLI entrypoint: writes MEMORY.txt under <rootDir>/manager/ (default cwd). */
export async function generateMemory(rootDir = process.cwd()): Promise<string> {
  const migrationCount = await pool.query<{ count: string }>(
    "SELECT count(*) AS count FROM migrations WHERE status = 'applied'"
  );
  const applied = migrationCount.rows[0]?.count ?? "0";

  const md = await generateMemoryMarkdown(rootDir);
  const outPath = resolveManagerPath(rootDir, "MEMORY.txt");

  let finalMd = md;
  const existing = await readFile(outPath, "utf8").catch(() => null);
  if (existing !== null) {
    const merged = mergeRunLogBlock(existing, extractRunLogBlock(md));
    if (merged !== null) {
      finalMd = merged;
    }
  }

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, finalMd, "utf8");
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

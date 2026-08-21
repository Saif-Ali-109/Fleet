import { readFile, appendFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolveManagerPath } from "./paths.ts";

const RUN_LOG_HEADER = "## Run log (appended by orchestrator)";

/**
 * MEMORY.md is the durable, cross-run knowledge file (decision 7). The orchestrator is the
 * only writer. Hand-curated sections at the top are preserved; per-run outcomes are appended
 * as one-line entries under a dedicated "Run log" section at the end.
 */
export async function readMemory(rootDir: string): Promise<string> {
  const p = resolveManagerPath(rootDir, "MEMORY.md");
  return existsSync(p) ? readFile(p, "utf8") : "";
}

export async function appendRunOutcome(
  rootDir: string,
  entry: { runId: string; repo: string; issue: number; outcome: string; prUrl?: string; costUsd: number },
): Promise<void> {
  const p = resolveManagerPath(rootDir, "MEMORY.md");
  const now = new Date().toISOString().slice(0, 10);
  const line =
    `- \`${now}\` **${entry.repo}#${entry.issue}** (${entry.runId}): ${entry.outcome}` +
    (entry.prUrl ? ` → [PR](${entry.prUrl})` : "") +
    ` · $${entry.costUsd.toFixed(4)}`;

  const current = existsSync(p) ? await readFile(p, "utf8") : "# MEMORY.md\n";
  if (current.includes(RUN_LOG_HEADER)) {
    await appendFile(p, `${line}\n`, "utf8");
  } else {
    await writeFile(p, `${current.trimEnd()}\n\n${RUN_LOG_HEADER}\n${line}\n`, "utf8");
  }
}

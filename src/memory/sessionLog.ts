import { copyFile, mkdir, writeFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveManagerPath } from "./paths.ts";

/**
 * SESSION_LOG.txt lifecycle (decision 7): truly reset each run. The previous log is stashed
 * to `.runs/<runId>/SESSION_LOG.txt` first, then a fresh one is written to `manager/`.
 */
export async function resetSessionLog(
  rootDir: string,
  runDir: string,
  runId: string,
  header: { repo: string; issue: number; title: string },
): Promise<string> {
  const logPath = resolveManagerPath(rootDir, "SESSION_LOG.txt");
  await mkdir(runDir, { recursive: true });
  if (existsSync(logPath)) {
    await copyFile(logPath, join(runDir, "SESSION_LOG.txt"));
  }
  const now = new Date().toISOString();
  const fresh = `# SESSION_LOG.txt — run ${runId}

- Started: ${now}
- Repo: ${header.repo}
- Issue: #${header.issue} — ${header.title}
- Traces: \`.runs/${runId}/traces/*.jsonl\`

## Timeline
`;
  await writeFile(logPath, fresh, "utf8");
  return logPath;
}

/** Append one timestamped line to the current SESSION_LOG.txt timeline. */
export async function logLine(rootDir: string, message: string): Promise<void> {
  const now = new Date().toISOString();
  await appendFile(resolveManagerPath(rootDir, "SESSION_LOG.txt"), `- \`${now}\` ${message}\n`, "utf8");
}

/** Append a fenced block (e.g. a gate decision or a cost summary). */
export async function logBlock(rootDir: string, title: string, body: string): Promise<void> {
  const block = `\n### ${title}\n\n${body}\n`;
  await appendFile(resolveManagerPath(rootDir, "SESSION_LOG.txt"), block, "utf8");
}

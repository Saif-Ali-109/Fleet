import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveManagerPath } from "./paths.ts";

const RUN_HEADER_RE = /^# SESSION_LOG\.txt — run (\S+)/;

/**
 * Archive the previous live log so it lands next to the run it actually belongs to:
 * into `.runs/<owner>/SESSION_LOG.txt` when the owner run dir is determinable from
 * the log's own header (never clobbering an existing archive), else into the new
 * run dir as a clearly-labeled `SESSION_LOG-previous.txt`.
 */
async function archivePreviousSessionLog(
	rootDir: string,
	runDir: string,
	runId: string,
	previous: string,
): Promise<void> {
	const owner = previous.match(RUN_HEADER_RE)?.[1];
	if (owner && owner !== runId) {
		const ownerRunDir = join(rootDir, ".runs", owner);
		if (existsSync(ownerRunDir)) {
			const dest = join(ownerRunDir, "SESSION_LOG.txt");
			const finalDest = existsSync(dest)
				? join(ownerRunDir, "SESSION_LOG-previous.txt")
				: dest;
			await writeFile(finalDest, previous, "utf8");
			return;
		}
	}
	const label = owner
		? `# archived from previous run — belongs to run ${owner}\n`
		: "# archived from previous run\n";
	await writeFile(
		join(runDir, "SESSION_LOG-previous.txt"),
		`${label}\n${previous}`,
		"utf8",
	);
}

/**
 * SESSION_LOG.txt lifecycle (decision 7): truly reset each run. The previous run's log is
 * archived to ITS OWN `.runs/<id>/` dir (or labeled `SESSION_LOG-previous.txt` in the new
 * run dir when its owner is undeterminable), then a fresh one is written to `manager/`.
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
		const previous = await readFile(logPath, "utf8");
		await archivePreviousSessionLog(rootDir, runDir, runId, previous);
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
	await appendFile(
		resolveManagerPath(rootDir, "SESSION_LOG.txt"),
		`- \`${now}\` ${message}\n`,
		"utf8",
	);
}

/** Append a fenced block (e.g. a gate decision or a cost summary). */
export async function logBlock(
	rootDir: string,
	title: string,
	body: string,
): Promise<void> {
	const block = `\n### ${title}\n\n${body}\n`;
	await appendFile(
		resolveManagerPath(rootDir, "SESSION_LOG.txt"),
		block,
		"utf8",
	);
}

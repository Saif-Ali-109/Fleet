import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendRunOutcome, readMemory } from "../memory/memoryStore.ts";

const RUN_LOG_HEADER = "## Run log (appended by orchestrator)";

let root = "";
let managerDir = "";

function filePath(): string {
	return join(managerDir, "MEMORY.txt");
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "memory-store-"));
	managerDir = join(root, "manager");
	mkdirSync(managerDir, { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function outcome(
	overrides: Partial<Parameters<typeof appendRunOutcome>[1]> = {},
) {
	return {
		runId: "run-2026-08-01",
		repo: "octocat/hello-world",
		issue: 7,
		outcome: "fixed",
		costUsd: 1.2345,
		...(overrides as object),
	};
}

describe("readMemory", () => {
	it("returns an empty string when MEMORY.txt does not exist", async () => {
		expect(await readMemory(root)).toBe("");
	});

	it("returns the file contents when MEMORY.txt exists", async () => {
		writeFileSync(filePath(), "# MEMORY.txt\n\n## Context\n", "utf8");
		expect(await readMemory(root)).toBe("# MEMORY.txt\n\n## Context\n");
	});
});

describe("appendRunOutcome", () => {
	it("creates MEMORY.txt with the run-log header when no file exists yet", async () => {
		await appendRunOutcome(root, outcome());

		const content = readFileSync(filePath(), "utf8");
		expect(content).toContain(RUN_LOG_HEADER);
		expect(content).toContain(
			"**octocat/hello-world#7** (run-2026-08-01): fixed",
		);
		expect(content).toContain("$1.2345");
		expect(content).not.toContain("[PR]");
	});

	it("includes the PR link when prUrl is provided", async () => {
		await appendRunOutcome(
			root,
			outcome({ prUrl: "https://github.com/octocat/hello-world/pull/99" }),
		);

		const content = readFileSync(filePath(), "utf8");
		expect(content).toContain(
			"→ [PR](https://github.com/octocat/hello-world/pull/99)",
		);
	});

	it("formats the cost with 4 decimals", async () => {
		await appendRunOutcome(root, outcome({ costUsd: 3.5 }));
		expect(readFileSync(filePath(), "utf8")).toContain("$3.5000");
	});

	it("appends to an existing MEMORY.txt that already has the run-log header", async () => {
		writeFileSync(
			filePath(),
			`# MEMORY.txt\n\n${RUN_LOG_HEADER}\n- existing line\n`,
			"utf8",
		);

		await appendRunOutcome(root, outcome());

		const content = readFileSync(filePath(), "utf8");
		expect(content).toContain("- existing line");
		expect(content).toContain(
			"**octocat/hello-world#7** (run-2026-08-01): fixed",
		);
		expect(content.trim().split("\n")).toHaveLength(5);
	});

	it("inserts the run-log header when the existing file lacks it, preserving prior content", async () => {
		writeFileSync(
			filePath(),
			"Hand-curated notes from a previous run.\n",
			"utf8",
		);

		await appendRunOutcome(root, outcome());

		const content = readFileSync(filePath(), "utf8");
		expect(content).toContain("Hand-curated notes from a previous run.");
		expect(content.indexOf(RUN_LOG_HEADER)).toBeGreaterThan(
			content.indexOf("previous run"),
		);
		expect(content).toContain(
			"**octocat/hello-world#7** (run-2026-08-01): fixed",
		);
	});
});

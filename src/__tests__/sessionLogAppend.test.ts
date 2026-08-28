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
import { logBlock, logLine, resetSessionLog } from "../memory/sessionLog.ts";

let root = "";
let managerDir = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "session-log-append-"));
	managerDir = join(root, "manager");
	mkdirSync(managerDir, { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("logLine", () => {
	it("appends a timestamped line to the live session log, creating the file", async () => {
		await logLine(root, "coder finished the fix");

		const content = readFileSync(join(managerDir, "SESSION_LOG.txt"), "utf8");
		expect(content).toContain("coder finished the fix");
		expect(content).toMatch(
			/^- `\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z` coder finished the fix\n$/,
		);
	});

	it("appends after existing content", async () => {
		writeFileSync(
			join(managerDir, "SESSION_LOG.txt"),
			"# SESSION_LOG.txt — run alpha\n\n## Timeline\n",
			"utf8",
		);
		await logLine(root, "first entry");
		await logLine(root, "second entry");

		const content = readFileSync(join(managerDir, "SESSION_LOG.txt"), "utf8");
		expect(content).toContain("first entry");
		expect(content.indexOf("second entry")).toBeGreaterThan(
			content.indexOf("first entry"),
		);
	});
});

describe("logBlock", () => {
	it("appends a fenced block with the given title and body", async () => {
		writeFileSync(
			join(managerDir, "SESSION_LOG.txt"),
			"# SESSION_LOG.txt — run alpha\n",
			"utf8",
		);
		await logBlock(root, "Gate decision", "approved with cost $0.40");

		const content = readFileSync(join(managerDir, "SESSION_LOG.txt"), "utf8");
		expect(content).toContain(
			"\n### Gate decision\n\napproved with cost $0.40\n",
		);
	});
});

describe("resetSessionLog archive edge", () => {
	it("writes a labeled fallback when the previous log already belongs to the same runId", async () => {
		const runId = "run-same";
		writeFileSync(
			join(managerDir, "SESSION_LOG.txt"),
			`# SESSION_LOG.txt — run ${runId}\n\nsome old content\n`,
			"utf8",
		);

		await resetSessionLog(root, join(root, ".runs", runId), runId, {
			repo: "o/r",
			issue: 1,
			title: "t",
		});

		const fallback = readFileSync(
			join(root, ".runs", runId, "SESSION_LOG-previous.txt"),
			"utf8",
		);
		expect(
			fallback.startsWith(
				`# archived from previous run — belongs to run ${runId}\n`,
			),
		).toBe(true);
		expect(fallback).toContain("some old content");
	});
});

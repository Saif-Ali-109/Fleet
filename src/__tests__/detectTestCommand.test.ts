import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { detectTestCommand, splitTestCommand } from "../fleet/testCmd.ts";

function fakeRepo(): string {
	return mkdtempSync(join(tmpdir(), "detect-test-"));
}

describe("detectTestCommand", () => {
	it("returns package.json scripts.test when present", () => {
		const dir = fakeRepo();
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({ scripts: { test: "vitest run" } }),
			"utf8",
		);
		expect(detectTestCommand(dir)).toBe("vitest run");
		rmSync(dir, { recursive: true, force: true });
	});

	it("falls through to pytest when package.json has no scripts.test", () => {
		const dir = fakeRepo();
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({ scripts: { build: "tsc" } }),
			"utf8",
		);
		writeFileSync(join(dir, "pytest.ini"), "[pytest]\n", "utf8");
		expect(detectTestCommand(dir)).toBe("pytest");
		rmSync(dir, { recursive: true, force: true });
	});

	it("detects pytest from pyproject.toml [tool.pytest]", () => {
		const dir = fakeRepo();
		writeFileSync(
			join(dir, "pyproject.toml"),
			"[tool.pytest.ini_options]\n",
			"utf8",
		);
		expect(detectTestCommand(dir)).toBe("pytest");
		rmSync(dir, { recursive: true, force: true });
	});

	it("detects pytest from requirements.txt + tests/ dir", () => {
		const dir = fakeRepo();
		writeFileSync(join(dir, "requirements.txt"), "pytest\n", "utf8");
		mkdirSync(join(dir, "tests"), { recursive: true });
		expect(detectTestCommand(dir)).toBe("pytest");
		rmSync(dir, { recursive: true, force: true });
	});

	it("falls back to git status --porcelain (with a warning) when nothing matches", () => {
		const dir = fakeRepo();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(detectTestCommand(dir)).toBe("git status --porcelain");
			expect(warn).toHaveBeenCalled();
		} finally {
			warn.mockRestore();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("ignores an unparseable package.json", () => {
		const dir = fakeRepo();
		writeFileSync(join(dir, "package.json"), "not json", "utf8");
		writeFileSync(join(dir, "pytest.ini"), "[pytest]\n", "utf8");
		expect(detectTestCommand(dir)).toBe("pytest");
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("splitTestCommand", () => {
	it("splits a shell command string into argv tokens", () => {
		expect(splitTestCommand("vitest run --coverage")).toEqual([
			"vitest",
			"run",
			"--coverage",
		]);
		expect(splitTestCommand("  pytest  ")).toEqual(["pytest"]);
		expect(splitTestCommand("")).toEqual([]);
	});
});

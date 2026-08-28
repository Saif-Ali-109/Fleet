import { afterEach, describe, expect, it, vi } from "vitest";

const { execFileMock, spawnMock } = vi.hoisted(() => ({
	execFileMock: vi.fn(),
	spawnMock: vi.fn(),
}));

// gh.ts shells out through promisified execFile/spawn from node:child_process.
// Mock the module so no real `gh` binary is ever invoked in tests.
vi.mock("node:child_process", () => ({
	execFile: execFileMock,
	spawn: spawnMock,
}));

import { listOpenIssues } from "../github/gh.ts";

/** Execute the callback style used by promisify(execFile): (err, stdout, stderr). */
function resolveWith(stdout: string): void {
	execFileMock.mockImplementation(
		(
			_file: string,
			_args: string[],
			_opts: unknown,
			cb: (err: Error | null, out?: unknown, errOut?: string) => void,
		) => {
			cb(null, { stdout, stderr: "" });
		},
	);
}

function lastArgs(): string[] {
	const call = execFileMock.mock.calls.at(-1);
	return (call?.[1] as string[]) ?? [];
}

afterEach(() => {
	vi.clearAllMocks();
});

// Regression coverage for the "daemon silently caps at 100 open issues" bug:
// `--limit 100` used to be hardcoded, so repos with >100 open issues had a
// portion permanently invisible to the daemon with no warning logged.
describe("listOpenIssues", () => {
	it("requests a much higher --limit than the old hardcoded 100", async () => {
		resolveWith(JSON.stringify([{ number: 1, title: "a" }]));
		await listOpenIssues("acme/widget");
		const args = lastArgs();
		const limitIdx = args.indexOf("--limit");
		expect(limitIdx).toBeGreaterThanOrEqual(0);
		const limit = Number(args[limitIdx + 1]);
		expect(limit).toBeGreaterThan(100);
	});

	it("returns all issues sorted ascending by number", async () => {
		resolveWith(
			JSON.stringify([
				{ number: 42, title: "c" },
				{ number: 3, title: "a" },
				{ number: 17, title: "b" },
			]),
		);
		const issues = await listOpenIssues("acme/widget");
		expect(issues.map((i) => i.number)).toEqual([3, 17, 42]);
	});

	it("handles more than 100 open issues without truncating below the ceiling", async () => {
		const many = Array.from({ length: 250 }, (_, i) => ({
			number: i + 1,
			title: `issue ${i + 1}`,
		}));
		resolveWith(JSON.stringify(many));
		const issues = await listOpenIssues("acme/widget");
		expect(issues).toHaveLength(250);
	});

	it("warns when the result hits the sanity ceiling (truncation is never silent)", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		resolveWith(JSON.stringify([{ number: 1, title: "a" }]));
		const args = lastArgs;
		// Force the ceiling by resolving exactly the configured limit's worth of items.
		execFileMock.mockImplementation(
			(
				_file: string,
				callArgs: string[],
				_opts: unknown,
				cb: (err: Error | null, out?: unknown) => void,
			) => {
				const limitIdx = callArgs.indexOf("--limit");
				const limit = Number(callArgs[limitIdx + 1]);
				const items = Array.from({ length: limit }, (_, i) => ({
					number: i + 1,
					title: `issue ${i + 1}`,
				}));
				cb(null, { stdout: JSON.stringify(items), stderr: "" });
			},
		);
		await listOpenIssues("acme/widget");
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("ceiling"));
		warnSpy.mockRestore();
		void args;
	});

	it("does not warn when well under the ceiling", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		resolveWith(JSON.stringify([{ number: 1, title: "a" }]));
		await listOpenIssues("acme/widget");
		expect(warnSpy).not.toHaveBeenCalled();
		warnSpy.mockRestore();
	});
});

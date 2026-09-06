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

import {
	addIssueLabel,
	commentOnIssue,
	ensureLabels,
	hasIssueLabel,
	ISSUE_LABEL_DONE,
	ISSUE_LABEL_IN_PROGRESS,
	removeIssueLabel,
} from "../github/gh.ts";

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

function rejectWith(message: string): void {
	execFileMock.mockImplementation(
		(
			_file: string,
			_args: string[],
			_opts: unknown,
			cb: (err: Error | null, out?: string, errOut?: string) => void,
		) => {
			const err = new Error(message) as Error & { stderr?: string };
			err.stderr = message;
			cb(err, "", message);
		},
	);
}

const ghCalls = (): { file: string; args: string[] }[] =>
	execFileMock.mock.calls.map((c) => ({
		file: c[0] as string,
		args: c[1] as string[],
	}));

afterEach(() => {
	execFileMock.mockReset();
});

describe("issue lifecycle gh helpers", () => {
	it("addIssueLabel issues gh issue edit --add-label", async () => {
		resolveWith("");
		await addIssueLabel("owner", "repo", 42, ISSUE_LABEL_IN_PROGRESS);
		expect(ghCalls()[0]?.file).toBe("gh");
		expect(ghCalls()[0]?.args).toEqual([
			"issue",
			"edit",
			"42",
			"--repo",
			"owner/repo",
			"--add-label",
			"fleet/in-progress",
		]);
	});

	it("removeIssueLabel issues gh issue edit --remove-label", async () => {
		resolveWith("");
		await removeIssueLabel("owner", "repo", 42, ISSUE_LABEL_DONE);
		expect(ghCalls()[0]?.args).toEqual([
			"issue",
			"edit",
			"42",
			"--repo",
			"owner/repo",
			"--remove-label",
			"fleet/done",
		]);
	});

	it("commentOnIssue posts the body via gh issue comment --body", async () => {
		resolveWith("");
		await commentOnIssue(
			"owner",
			"repo",
			42,
			"Fleet started run `run-1` (backend: opencode).",
		);
		const call = ghCalls()[0];
		expect(call?.file).toBe("gh");
		expect(call?.args).toEqual([
			"issue",
			"comment",
			"42",
			"--repo",
			"owner/repo",
			"--body",
			"Fleet started run `run-1` (backend: opencode).",
		]);
	});

	it("ensureLabels creates every label with gh label create --force", async () => {
		resolveWith("");
		await ensureLabels("owner", "repo", [
			ISSUE_LABEL_IN_PROGRESS,
			ISSUE_LABEL_DONE,
		]);
		expect(ghCalls().length).toBe(2);
		expect(ghCalls()[0]?.args).toEqual([
			"label",
			"create",
			"fleet/in-progress",
			"--repo",
			"owner/repo",
			"--force",
		]);
		expect(ghCalls()[1]?.args).toEqual([
			"label",
			"create",
			"fleet/done",
			"--repo",
			"owner/repo",
			"--force",
		]);
	});

	it("hasIssueLabel reports true when the label is present", async () => {
		resolveWith(
			JSON.stringify({
				labels: [{ name: "fleet/in-progress" }, { name: "bug" }],
			}),
		);
		await expect(
			hasIssueLabel("owner", "repo", 42, ISSUE_LABEL_IN_PROGRESS),
		).resolves.toBe(true);
	});

	it("hasIssueLabel reports false when the label is absent", async () => {
		resolveWith(JSON.stringify({ labels: [{ name: "bug" }] }));
		await expect(
			hasIssueLabel("owner", "repo", 42, ISSUE_LABEL_IN_PROGRESS),
		).resolves.toBe(false);
	});

	it("hasIssueLabel reports false when gh fails", async () => {
		rejectWith("not found");
		await expect(
			hasIssueLabel("owner", "repo", 42, ISSUE_LABEL_IN_PROGRESS),
		).resolves.toBe(false);
	});
});

describe("non-fatal behavior", () => {
	it("addIssueLabel never throws when gh fails — it only warns", async () => {
		rejectWith("label already exists");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await expect(
				addIssueLabel("owner", "repo", 42, ISSUE_LABEL_DONE),
			).resolves.toBeUndefined();
			expect(warn).toHaveBeenCalled();
			expect(warn.mock.calls[0]?.[0]).toContain("non-fatal");
		} finally {
			warn.mockRestore();
		}
	});

	it("commentOnIssue never throws when gh fails — it only warns", async () => {
		rejectWith("boom");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await expect(
				commentOnIssue("owner", "repo", 42, "Fleet run `x` failed."),
			).resolves.toBeUndefined();
			expect(warn).toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it("ensureLabels continues after one failing label and never throws", async () => {
		execFileMock
			.mockImplementationOnce(
				(
					_file: string,
					_args: string[],
					_opts: unknown,
					cb: (err: Error | null, out?: unknown) => void,
				) => cb(new Error("failed")),
			)
			.mockImplementation(
				(
					_file: string,
					_args: string[],
					_opts: unknown,
					cb: (err: Error | null, out?: unknown) => void,
				) => cb(null, { stdout: "", stderr: "" }),
			);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await expect(
				ensureLabels("owner", "repo", [
					ISSUE_LABEL_IN_PROGRESS,
					ISSUE_LABEL_DONE,
				]),
			).resolves.toBeUndefined();
			expect(execFileMock).toHaveBeenCalledTimes(2);
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});
});

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pruneOldRunDirs } from "../worktree.ts";

// Regression coverage for unbounded `.runs/` growth: `cleanupWorktree` only
// ever tore down the linked worktree (`full` was never passed as `true`),
// so per-run clone/trace directories accumulated forever under long-running
// daemon use. `pruneOldRunDirs` is the retention sweep that deletes run
// directories once they're older than the retention window.
function mkOldDir(root: string, name: string, ageDays: number): string {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "marker.txt"), "x");
	const past = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
	utimesSync(dir, past, past);
	return dir;
}

describe("pruneOldRunDirs", () => {
	it("returns empty result when the runs root doesn't exist", async () => {
		const root = join(mkdtempSync(join(tmpdir(), "prune-")), "does-not-exist");
		const result = await pruneOldRunDirs(root, 7);
		expect(result).toEqual({ removed: [], errors: [] });
	});

	it("removes directories older than maxAgeDays and keeps recent ones", async () => {
		const root = mkdtempSync(join(tmpdir(), "prune-"));
		try {
			const oldDir = mkOldDir(root, "run-old", 30);
			const freshDir = mkOldDir(root, "run-fresh", 1);

			const result = await pruneOldRunDirs(root, 7);

			expect(result.removed).toEqual(["run-old"]);
			expect(result.errors).toEqual([]);
			expect(existsSync(oldDir)).toBe(false);
			expect(existsSync(freshDir)).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("never throws — reports per-entry errors instead", async () => {
		const root = mkdtempSync(join(tmpdir(), "prune-"));
		try {
			// A regular file (not a directory) alongside a real old run dir should
			// simply be skipped, not crash the sweep.
			writeFileSync(join(root, "not-a-dir.txt"), "x");
			mkOldDir(root, "run-old", 30);

			const result = await pruneOldRunDirs(root, 7);

			expect(result.removed).toEqual(["run-old"]);
			expect(result.errors).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyChain } from "../db/audit.ts";
import { runSorVerify } from "../sor/verify.ts";

vi.mock("../db/audit.ts", () => ({
	verifyChain: vi.fn(),
}));

const fakePool = {} as unknown as Pool;

describe("runSorVerify", () => {
	const logs: string[] = [];
	let logSpy: ReturnType<typeof vi.spyOn>;

	afterEach(() => {
		logSpy.mockRestore();
		vi.mocked(verifyChain).mockReset();
	});

	beforeEach(() => {
		logs.length = 0;
		logSpy = vi
			.spyOn(console, "log")
			.mockImplementation((...args: unknown[]) => {
				logs.push(args.map(String).join(" "));
			});
	});

	it("reports an empty chain as ok and exits 0", async () => {
		vi.mocked(verifyChain).mockResolvedValueOnce({
			ok: true,
			total: 0,
			counts: {},
			firstBadSeq: null,
		});

		const code = await runSorVerify(fakePool);

		expect(code).toBe(0);
		expect(logs).toEqual([
			"chain verification report",
			"-------------------------",
			"(no audit events)",
			"total: 0",
			"ok: yes",
		]);
	});

	it("prints counts sorted by event type name", async () => {
		vi.mocked(verifyChain).mockResolvedValueOnce({
			ok: true,
			total: 3,
			counts: { wakeup: 1, tool_call: 2 },
			firstBadSeq: null,
		});

		const code = await runSorVerify(fakePool);

		expect(code).toBe(0);
		expect(logs).toContain("tool_call: 2");
		expect(logs).toContain("wakeup: 1");
		expect(logs).toContain("total: 3");
		expect(logs).toContain("ok: yes");
		const toolIdx = logs.indexOf("tool_call: 2");
		const wakeIdx = logs.indexOf("wakeup: 1");
		expect(wakeIdx).toBeGreaterThan(toolIdx);
	});

	it("reports the first bad seq and exits 1 for a broken chain", async () => {
		vi.mocked(verifyChain).mockResolvedValueOnce({
			ok: false,
			total: 4,
			counts: { phase: 4 },
			firstBadSeq: 2,
		});

		const code = await runSorVerify(fakePool);

		expect(code).toBe(1);
		expect(logs).toContain("phase: 4");
		expect(logs).toContain("ok: no");
		expect(logs).toContain("first bad seq: 2");
	});
});

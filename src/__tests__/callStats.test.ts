import { describe, it, expect, vi, beforeEach } from "vitest";
import { upsertAgentCallStats, sessionCallTotals } from "../db/queries/callStats.ts";
import type { Pool } from "pg";

function mockPool(): Pool {
  return { query: vi.fn() } as unknown as Pool;
}

describe("callStats", () => {
  let pool: Pool;
  beforeEach(() => { pool = mockPool(); });

  describe("upsertAgentCallStats", () => {
    it("calls pool.query with correct params", async () => {
      const query = vi.fn().mockResolvedValue({ rows: [] });
      pool = { query } as unknown as Pool;
      await upsertAgentCallStats(pool, "run-123", {
        role: "coder", model: "gemini-3.5-flash", provider: "gemini",
        sessionId: "sess-1", toolCalls: 14, modelCalls: 6, skillLoads: 2,
        toolBreakdown: { read: 4, bash: 5, glob: 3, load_skill: 2 },
      });
      expect(query).toHaveBeenCalledOnce();
      expect(query.mock.calls[0]![0]).toContain("INSERT INTO agent_call_stats");
      expect(query.mock.calls[0]![1]).toEqual([
        "run-123", "coder", "gemini-3.5-flash", "gemini", "sess-1",
        14, 6, 2, '{"read":4,"bash":5,"glob":3,"load_skill":2}',
      ]);
    });

    it("does not throw on pool.query rejection", async () => {
      const query = vi.fn().mockRejectedValue(new Error("connection lost"));
      pool = { query } as unknown as Pool;
      await expect(
        upsertAgentCallStats(pool, "r", {
          role: "coder", model: null, provider: null, sessionId: null,
          toolCalls: 0, modelCalls: 0, skillLoads: 0, toolBreakdown: {},
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe("sessionCallTotals", () => {
    it("returns summed totals from query result", async () => {
      const query = vi.fn().mockResolvedValue({
        rows: [{ tools: 47, models: 21, skills: 5 }],
      });
      pool = { query } as unknown as Pool;
      const result = await sessionCallTotals(pool, "run-123");
      expect(result).toEqual({ tools: 47, models: 21, skills: 5 });
      expect(query.mock.calls[0]![0]).toContain("SUM(tool_calls)");
      expect(query.mock.calls[0]![1]).toEqual(["run-123"]);
    });

    it("returns zeros on error", async () => {
      const query = vi.fn().mockRejectedValue(new Error("table missing"));
      pool = { query } as unknown as Pool;
      const result = await sessionCallTotals(pool, "r");
      expect(result).toEqual({ tools: 0, models: 0, skills: 0 });
    });
  });
});

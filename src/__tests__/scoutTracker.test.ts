import { describe, it, expect } from "vitest";
import { ScoutTracker } from "../workflow/scoutTracker.ts";

describe("ScoutTracker", () => {
  it("counts a task tool_call part whose input mentions scout", () => {
    const t = new ScoutTracker();
    const ev = {
      type: "message",
      part: {
        type: "tool_call",
        tool: "task",
        state: { input: { description: "scout the repo", prompt: "..." } },
      },
    };
    expect(t.observe("analyzer", ev)).toBe(true);
    expect(t.total).toBe(1);
    expect(t.summary()).toBe("scout calls: 1 total (analyzer=1)");
  });

  it("counts the message.tool shape", () => {
    const t = new ScoutTracker();
    const ev = { type: "message", message: { tool: "task", input: { description: "use scout" } } };
    expect(t.observe("planner", ev)).toBe(true);
    expect(t.total).toBe(1);
  });

  it("ignores non-task tools", () => {
    const t = new ScoutTracker();
    expect(
      t.observe("reviewer", {
        type: "message",
        part: { type: "tool", tool: "read", state: { input: { path: "scout.md" } } },
      }),
    ).toBe(false);
    expect(t.total).toBe(0);
    expect(t.summary()).toBe("scout calls: 0");
  });

  it("is case-insensitive on scout and requires the task tool", () => {
    const t = new ScoutTracker();
    expect(
      t.observe("planner", {
        type: "message",
        part: { type: "tool_call", tool: "grep", state: { input: { pattern: "SCOUT" } } },
      }),
    ).toBe(false);
    expect(
      t.observe("planner", {
        type: "message",
        part: { type: "tool_call", tool: "task", state: { input: { prompt: "Ask SCOUT for symbols" } } },
      }),
    ).toBe(true);
    expect(t.total).toBe(1);
  });

  it("aggregates per-parent counts in summary", () => {
    const t = new ScoutTracker();
    const ev = (role: string) => ({
      type: "message",
      part: { type: "tool_call", tool: "task", state: { input: { description: `scout via ${role}` } } },
    });
    t.observe("analyzer", ev("a"));
    t.observe("planner", ev("p"));
    t.observe("planner", ev("p"));
    t.observe("reviewer", ev("r"));
    expect(t.total).toBe(4);
    expect(t.summary()).toBe("scout calls: 4 total (analyzer=1, planner=2, reviewer=1)");
  });

  it("never throws on garbage input", () => {
    const t = new ScoutTracker();
    expect(() => t.observe("coder", {} as Record<string, unknown>)).not.toThrow();
    expect(() => t.observe("coder", { part: null })).not.toThrow();
    expect(() => t.observe("coder", { part: { type: "tool_call" } })).not.toThrow();
    expect(() => t.observe("pr", undefined as unknown as Record<string, unknown>)).not.toThrow();
    expect(t.total).toBe(0);
    expect(t.summary()).toBe("scout calls: 0");
  });
});

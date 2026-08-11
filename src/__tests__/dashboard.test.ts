import { describe, it, expect } from "vitest";
import { newDashboardState, renderDashboard } from "../tui/dashboard.js";
import type { Role } from "../types.js";

const ROLES: Role[] = ["analyzer", "planner", "coder", "tester", "reviewer", "pr"];

describe("dashboard", () => {
  describe("newDashboardState", () => {
    it("initializes phase to idle", () => {
      const d = newDashboardState("run-1", "owner/repo", 7);
      expect(d.phase).toBe("idle");
    });

    it("stores the run metadata", () => {
      const d = newDashboardState("run-abc", "owner/repo", 7);
      expect(d.runId).toBe("run-abc");
      expect(d.repo).toBe("owner/repo");
      expect(d.issue).toBe(7);
    });

    it("initializes loopIteration to 1", () => {
      const d = newDashboardState("run-1", "owner/repo", 7);
      expect(d.loopIteration).toBe(1);
    });

    it("creates a pending placeholder agent status for every role", () => {
      const d = newDashboardState("run-1", "owner/repo", 7);
      for (const role of ROLES) {
        expect(d.agents[role]).toMatchObject({
          role,
          state: "pending",
          model: "",
        });
      }
    });

    it("defaults backend to opencode", () => {
      const d = newDashboardState("run-1", "owner/repo", 7);
      expect(d.backend).toBe("opencode");
    });

    it("records a supplied backend", () => {
      const d = newDashboardState("run-1", "owner/repo", 7, "codex");
      expect(d.backend).toBe("codex");
    });
  });

  describe("renderDashboard", () => {
    it("includes the run id, repo and issue in the header", () => {
      const d = newDashboardState("run-42", "owner/repo", 7);
      const out = renderDashboard(d);
      expect(out).toContain("run-42");
      expect(out).toContain("owner/repo#7");
    });

    it("shows the backend in the header", () => {
      const d = newDashboardState("run-42", "owner/repo", 7, "claude");
      const out = renderDashboard(d);
      expect(out).toContain("claude");
    });

    it("lists every role", () => {
      const d = newDashboardState("run-1", "owner/repo", 7);
      const out = renderDashboard(d);
      for (const role of ROLES) {
        expect(out).toContain(role);
      }
    });

    it("renders a '·' bullet for pending agents", () => {
      const d = newDashboardState("run-1", "owner/repo", 7);
      const out = renderDashboard(d);
      expect(out).toContain("·");
    });

    it("renders a '✓' and cost for a done agent with cost info", () => {
      const d = newDashboardState("run-1", "owner/repo", 7);
      d.phase = "done";
      d.agents.coder = {
        role: "coder",
        state: "done",
        model: "opencode/laguna-s-2.1-free",
        costUsd: 0.123,
        tokens: { input: 10, output: 5, reasoning: 0, total: 15 },
      };
      const out = renderDashboard(d);
      expect(out).toContain("✓");
      expect(out).toContain("$0.123");
    });

    it("renders a '✗' and error for a failed agent", () => {
      const d = newDashboardState("run-1", "owner/repo", 7);
      d.phase = "failed";
      d.agents.analyzer = {
        role: "analyzer",
        state: "failed",
        model: "opencode/deepseek-v4-flash-free",
        error: "timeout",
      };
      const out = renderDashboard(d);
      expect(out).toContain("✗");
      expect(out).toContain("timeout");
    });
  });
});

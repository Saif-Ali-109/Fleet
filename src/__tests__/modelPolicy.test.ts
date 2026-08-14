import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Backend, Role } from "../types.js";
import {
  availableModels,
  BACKENDS,
  CLAUDE_MODELS,
  CODEX_MODELS,
  FREE_OPCODE_MODELS,
  allPolicies,
  getModelOverrides,
  loadModelOverrides,
  policyFor,
  resetModelOverrides,
  saveModelOverrides,
  setModelOverride,
} from "../models/modelPolicy.js";

describe("modelPolicy", () => {
  const roles: Role[] = ["analyzer", "planner", "coder", "tester", "reviewer", "pr"];

  // Mutable override layer must not leak state between tests.
  beforeEach(() => resetModelOverrides());

  describe("policyFor (opencode default)", () => {
    it("returns the deepseek model for reasoning-heavy roles", () => {
      for (const role of ["analyzer", "planner", "reviewer"] as Role[]) {
        expect(policyFor(role).model).toBe("opencode/deepseek-v4-flash-free");
      }
    });

    it("returns the laguna model for building roles", () => {
      for (const role of ["coder", "tester", "pr"] as Role[]) {
        expect(policyFor(role).model).toBe("opencode/laguna-s-2.1-free");
      }
    });

    it("returns a low variant for analyzer/planner/reviewer", () => {
      for (const role of ["analyzer", "planner", "reviewer"] as Role[]) {
        expect(policyFor(role).variant).toBe("low");
      }
    });

    it("includes at least 3 fallback models for every role", () => {
      for (const role of roles) {
        expect(policyFor(role).fallbacks.length).toBeGreaterThanOrEqual(3);
      }
    });
  });

  describe("policyFor (claude backend)", () => {
    it("defaults to the claude builder model for every role", () => {
      for (const role of roles) {
        expect(policyFor(role, "claude").model).toBe("sonnet");
      }
    });

    it("keeps bare (non-prefixed) model ids", () => {
      expect(policyFor("analyzer", "claude").model).toBe("sonnet");
    });
  });

  describe("policyFor (codex backend)", () => {
    it("defaults to the codex builder model for every role", () => {
      for (const role of roles) {
        expect(policyFor(role, "codex").model).toBe("gpt-5.1-codex");
      }
    });

    it("keeps bare (non-prefixed) model ids", () => {
      expect(policyFor("coder", "codex").model).toBe("gpt-5.1-codex");
    });
  });

  describe("availableModels", () => {
    it("exposes a curated catalog for each backend", () => {
      expect(availableModels("opencode")).toEqual(FREE_OPCODE_MODELS);
      expect(availableModels("claude")).toEqual(CLAUDE_MODELS);
      expect(availableModels("codex")).toEqual(CODEX_MODELS);
    });

    it("BACKENDS lists exactly the three supported backends", () => {
      expect(BACKENDS).toEqual(["opencode", "claude", "codex"]);
    });
  });

  describe("model overrides (per backend)", () => {
    it("round-trips per-role overrides within a single backend", () => {
      setModelOverride("analyzer", "sonnet", "claude");
      expect(getModelOverrides().claude?.analyzer).toBe("sonnet");
    });

    it("isolates overrides between backends", () => {
      setModelOverride("analyzer", "sonnet", "claude");
      setModelOverride("analyzer", "opus", "claude");
      expect(getModelOverrides().claude?.analyzer).toBe("opus");
    });

    it("policyFor merges override over default", () => {
      setModelOverride("analyzer", "opus", "claude");
      expect(policyFor("analyzer", "claude").model).toBe("opus");
      // opencode untouched
      expect(policyFor("analyzer").model).toBe("opencode/deepseek-v4-flash-free");
    });

    it("rejects invalid models per backend", () => {
      expect(() => setModelOverride("analyzer", "gpt-5.1-codex", "claude")).toThrow();
      expect(() => setModelOverride("analyzer", "sonnet", "codex")).toThrow();
      expect(() => setModelOverride("analyzer", "opencode/deepseek-v4-flash-free")).toThrow();
      expect(getModelOverrides().claude).toBeUndefined();
    });

    it("accepts a valid model without throwing", () => {
      expect(() => setModelOverride("analyzer", "opus", "claude")).not.toThrow();
      expect(getModelOverrides().claude?.analyzer).toBe("opus");
    });
  });

  describe("persistence (nested per-backend shape)", () => {
    it("saves and reloads nested per-backend overrides", () => {
      setModelOverride("analyzer", "opus", "claude");
      setModelOverride("coder", "gpt-5.4-codex", "codex");
      const root = mkdtempSync(join(tmpdir(), "mp-save-"));
      const path = join(root, "out", "overrides.json");
      saveModelOverrides(path);
      const persisted = JSON.parse(readFileSync(path, "utf8"));
      expect(persisted).toEqual({
        claude: { analyzer: "opus" },
        codex: { coder: "gpt-5.4-codex" },
      });
      const before = getModelOverrides();
      resetModelOverrides();
      expect(getModelOverrides()).toEqual({});
      loadModelOverrides(path);
      expect(getModelOverrides()).toEqual(before);
      rmSync(root, { recursive: true, force: true });
    });

    it("loads a legacy flat file as opencode overrides", () => {
      const root = mkdtempSync(join(tmpdir(), "mp-load-"));
      const path = join(root, "models.json");
      writeFileSync(path, JSON.stringify({ analyzer: "ling-3.0-tiny-free", pr: "north-mini-code-free" }));
      loadModelOverrides(path);
      const ov = getModelOverrides();
      expect(ov.opencode?.analyzer).toBe("ling-3.0-tiny-free");
      expect(ov.opencode?.pr).toBe("north-mini-code-free");
      expect(ov.opencode?.coder).toBeUndefined();
      expect(policyFor("analyzer").model).toBe("opencode/ling-3.0-tiny-free");
      rmSync(root, { recursive: true, force: true });
    });

    it("self-seeds nested defaults when file is missing", () => {
      const root = mkdtempSync(join(tmpdir(), "mp-seed-"));
      const path = join(root, "nested", "deep", "models.json");
      expect(existsSync(path)).toBe(false);
      loadModelOverrides(path);
      expect(existsSync(path)).toBe(true);
      const seeded = JSON.parse(readFileSync(path, "utf8"));
      expect(seeded.opencode).toEqual({
        analyzer: "deepseek-v4-flash-free",
        planner: "deepseek-v4-flash-free",
        coder: "laguna-s-2.1-free",
        tester: "laguna-s-2.1-free",
        reviewer: "deepseek-v4-flash-free",
        pr: "laguna-s-2.1-free",
      });
      expect(seeded.claude).toEqual({
        analyzer: "sonnet",
        planner: "sonnet",
        coder: "sonnet",
        tester: "sonnet",
        reviewer: "sonnet",
        pr: "sonnet",
      });
      expect(seeded.codex).toEqual({
        analyzer: "gpt-5.1-codex",
        planner: "gpt-5.1-codex",
        coder: "gpt-5.1-codex",
        tester: "gpt-5.1-codex",
        reviewer: "gpt-5.1-codex",
        pr: "gpt-5.1-codex",
      });
      rmSync(root, { recursive: true, force: true });
    });

    it("resetModelOverrides clears all backends", () => {
      setModelOverride("analyzer", "opus", "claude");
      setModelOverride("coder", "gpt-5.4-codex", "codex");
      expect(Object.keys(getModelOverrides())).toEqual(["claude", "codex"]);
      resetModelOverrides();
      expect(getModelOverrides()).toEqual({});
    });
  });

  describe("allPolicies", () => {
    it("returns a policy for every role on the given backends", () => {
      const policies = allPolicies(["opencode", "claude"]);
      expect(policies).toHaveLength(12);
      const byKey = new Map(policies.map((p) => [`${p.model}-${p.role}`, p]));
      expect(byKey.get("sonnet-analyzer")).toBeDefined();
    });
  });
});

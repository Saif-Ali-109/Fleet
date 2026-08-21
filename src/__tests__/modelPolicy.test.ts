import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Backend, Role } from "../types.ts";
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
} from "../models/modelPolicy.ts";

describe("modelPolicy", () => {
  const roles: Role[] = ["analyzer", "planner", "coder", "tester", "reviewer", "pr"];

  // Mutable override layer must not leak state between tests.
  beforeEach(() => resetModelOverrides());

  describe("policyFor (opencode default)", () => {
    it("returns the x-preview model for reasoning-heavy roles", () => {
      for (const role of ["analyzer", "planner", "reviewer"] as Role[]) {
        expect(policyFor(role).model).toBe("opencode/x-preview-f-free");
      }
    });

    it("returns the mimo model for building roles", () => {
      for (const role of ["coder", "tester", "pr"] as Role[]) {
        expect(policyFor(role).model).toBe("opencode/mimo-v2.5-free");
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
        expect(policyFor(role, "claude").model).toBe("anthropic/claude-3.5-sonnet");
      }
    });

    it("keeps bare (non-prefixed) model ids", () => {
      setModelOverride("analyzer", "sonnet", "claude");
      expect(policyFor("analyzer", "claude").model).toBe("sonnet");
    });
  });

  describe("policyFor (codex backend)", () => {
    it("defaults to the codex builder model for every role", () => {
      for (const role of roles) {
        expect(policyFor(role, "codex").model).toBe("openai/gpt-4o-mini");
      }
    });

    it("keeps bare (non-prefixed) model ids", () => {
      setModelOverride("coder", "gpt-5.1-codex", "codex");
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
      expect(policyFor("analyzer").model).toBe("opencode/x-preview-f-free");
    });

    it("accepts custom/free-text model ids per backend", () => {
      expect(() => setModelOverride("analyzer", "anthropic/claude-3-7-sonnet-20250219", "claude")).not.toThrow();
      expect(getModelOverrides().claude?.analyzer).toBe("anthropic/claude-3-7-sonnet-20250219");
      expect(() => setModelOverride("analyzer", "openai/gpt-4o-mini", "codex")).not.toThrow();
      expect(() => setModelOverride("coder", "anthropic/claude-3-5-sonnet-20241022", "opencode")).not.toThrow();
      expect(() => setModelOverride("analyzer", "", "opencode")).toThrow();
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
      // App-default location, mirroring src/index.ts (<rootDir>/manager/models.json).
      const path = join(root, "manager", "models.json");
      mkdirSync(join(root, "manager"), { recursive: true });
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
        analyzer: "x-preview-f-free",
        planner: "x-preview-f-free",
        coder: "mimo-v2.5-free",
        tester: "mimo-v2.5-free",
        reviewer: "x-preview-f-free",
        pr: "mimo-v2.5-free",
      });
      expect(seeded.claude).toEqual({
        analyzer: "anthropic/claude-3.5-sonnet",
        planner: "anthropic/claude-3.5-sonnet",
        coder: "anthropic/claude-3.5-sonnet",
        tester: "anthropic/claude-3.5-sonnet",
        reviewer: "anthropic/claude-3.5-sonnet",
        pr: "anthropic/claude-3.5-sonnet",
      });
      expect(seeded.codex).toEqual({
        analyzer: "openai/gpt-4o-mini",
        planner: "openai/gpt-4o-mini",
        coder: "openai/gpt-4o-mini",
        tester: "openai/gpt-4o-mini",
        reviewer: "openai/gpt-4o-mini",
        pr: "openai/gpt-4o-mini",
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
      expect(byKey.get("anthropic/claude-3.5-sonnet-analyzer")).toBeDefined();
    });
  });
});

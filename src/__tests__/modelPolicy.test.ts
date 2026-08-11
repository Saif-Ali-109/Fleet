import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Role } from "../types.js";
import {
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

  // Phase 0: mutable override layer must not leak state between tests.
  beforeEach(() => resetModelOverrides());

  describe("policyFor", () => {
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

    it("returns a deep model with medium variant for analyzer/planner/reviewer", () => {
      for (const role of ["analyzer", "planner", "reviewer"] as Role[]) {
        expect(policyFor(role).variant).toBe("medium");
      }
    });

    it("returns no variant override for coder/tester/pr", () => {
      for (const role of ["coder", "tester", "pr"] as Role[]) {
        expect(policyFor(role).variant).toBeUndefined();
      }
    });

    it("includes at least 3 fallback models for every role", () => {
      for (const role of roles) {
        expect(policyFor(role).fallbacks.length).toBeGreaterThanOrEqual(3);
      }
    });

    it("the role field matches the requested role", () => {
      for (const role of roles) {
        expect(policyFor(role).role).toBe(role);
      }
    });
  });

  describe("allPolicies", () => {
    it("returns a policy for every role", () => {
      const policies = allPolicies();
      const byRole = new Map(policies.map((p) => [p.role, p]));
      for (const role of roles) {
        expect(byRole.has(role)).toBe(true);
      }
    });

    it("returns a stable length of 6", () => {
      expect(allPolicies()).toHaveLength(6);
    });
  });

  describe("FREE_OPCODE_MODELS", () => {
    it("exposes the expected set of free OpenCode models", () => {
      expect(FREE_OPCODE_MODELS).toEqual([
        "deepseek-v4-flash-free",
        "laguna-s-2.1-free",
        "ling-3.0-tiny-free",
        "longcat-2.0-free",
        "mimo-v2.5-free",
        "nemotron-3-ultra-free",
        "north-mini-code-free",
      ]);
    });
  });

  describe("model overrides", () => {
    it("setModelOverride + getModelOverrides round-trip (per role)", () => {
      const mapping: Record<Role, string> = {
        analyzer: "deepseek-v4-flash-free",
        planner: "laguna-s-2.1-free",
        coder: "ling-3.0-tiny-free",
        tester: "longcat-2.0-free",
        reviewer: "mimo-v2.5-free",
        pr: "nemotron-3-ultra-free",
      };
      for (const role of roles) {
        setModelOverride(role, mapping[role]);
        expect(getModelOverrides()[role]).toBe(mapping[role]);
      }
      expect(getModelOverrides()).toEqual(mapping);
    });

    it("setModelOverride rejects invalid model (not in FREE_OPCODE_MODELS)", () => {
      // bare unknown ids
      expect(() => setModelOverride("analyzer", "gpt-4")).toThrow();
      expect(() => setModelOverride("coder", "deepseek")).toThrow();
      // prefixed ids are intentionally not accepted (bare form is the contract)
      expect(() => setModelOverride("analyzer", "opencode/deepseek-v4-flash-free")).toThrow();
      // an invalid call must not mutate the override layer
      expect(() => setModelOverride("analyzer", "nope")).toThrow();
      expect(getModelOverrides().analyzer).toBeUndefined();
    });

    it("setModelOverride accepts a valid model without throwing", () => {
      expect(() => setModelOverride("analyzer", "ling-3.0-tiny-free")).not.toThrow();
      expect(getModelOverrides().analyzer).toBe("ling-3.0-tiny-free");
    });

    it("policyFor merges override over default (and keeps other fields)", () => {
      // default first: no override => POLICIES default (prefixed, valid for -m)
      expect(policyFor("analyzer").model).toBe("opencode/deepseek-v4-flash-free");

      setModelOverride("analyzer", "laguna-s-2.1-free");
      const p = policyFor("analyzer");
      // override wins; bare id is normalized to the opencode/ form runWorker needs
      expect(p.model).toBe("opencode/laguna-s-2.1-free");
      // default variant + fallbacks preserved (only model is overridden)
      expect(p.role).toBe("analyzer");
      expect(p.variant).toBe("medium");
      expect(p.fallbacks.length).toBeGreaterThanOrEqual(3);
      // only the targeted role changed; sibling roles stay on their defaults
      expect(policyFor("coder").model).toBe("opencode/laguna-s-2.1-free");
    });

    it("allPolicies reflects per-role overrides", () => {
      setModelOverride("reviewer", "longcat-2.0-free");
      const byRole = new Map(allPolicies().map((p) => [p.role, p.model]));
      expect(byRole.get("reviewer")).toBe("opencode/longcat-2.0-free");
      expect(byRole.get("coder")).toBe("opencode/laguna-s-2.1-free");
    });

    it("loadModelOverrides reads an existing file", () => {
      const root = mkdtempSync(join(tmpdir(), "mp-load-"));
      const path = join(root, "models.json");
      writeFileSync(
        path,
        JSON.stringify({
          analyzer: "ling-3.0-tiny-free",
          pr: "north-mini-code-free",
        }),
      );
      loadModelOverrides(path);
      const ov = getModelOverrides();
      expect(ov.analyzer).toBe("ling-3.0-tiny-free");
      expect(ov.pr).toBe("north-mini-code-free");
      expect(ov.coder).toBeUndefined();
      expect(policyFor("analyzer").model).toBe("opencode/ling-3.0-tiny-free");
      rmSync(root, { recursive: true, force: true });
    });

    it("loadModelOverrides self-seeds when file is missing (creates it with defaults)", () => {
      const root = mkdtempSync(join(tmpdir(), "mp-seed-"));
      // nested, non-existent path to also exercise directory creation
      const path = join(root, "nested", "deep", "models.json");
      expect(existsSync(path)).toBe(false);
      loadModelOverrides(path);
      expect(existsSync(path)).toBe(true);
      const seeded = JSON.parse(readFileSync(path, "utf8"));
      expect(seeded).toEqual({
        analyzer: "deepseek-v4-flash-free",
        planner: "deepseek-v4-flash-free",
        coder: "laguna-s-2.1-free",
        tester: "laguna-s-2.1-free",
        reviewer: "deepseek-v4-flash-free",
        pr: "laguna-s-2.1-free",
      });
      // after self-seed, overrides reflect the seeded defaults
      expect(getModelOverrides()).toEqual(seeded);
      rmSync(root, { recursive: true, force: true });
    });

    it("saveModelOverrides persists current overrides to disk (temp dir)", () => {
      setModelOverride("analyzer", "ling-3.0-tiny-free");
      setModelOverride("pr", "nemotron-3-ultra-free");
      const root = mkdtempSync(join(tmpdir(), "mp-save-"));
      const path = join(root, "out", "overrides.json");
      saveModelOverrides(path);
      const persisted = JSON.parse(readFileSync(path, "utf8"));
      expect(persisted).toEqual({
        analyzer: "ling-3.0-tiny-free",
        pr: "nemotron-3-ultra-free",
      });
      const before = getModelOverrides();
      // round-trip: clearing memory and reloading from the saved file restores the same overrides
      resetModelOverrides();
      expect(getModelOverrides()).toEqual({});
      loadModelOverrides(path);
      expect(getModelOverrides()).toEqual(before);
      rmSync(root, { recursive: true, force: true });
    });

    it("resetModelOverrides clears overrides", () => {
      for (const role of roles) setModelOverride(role, "laguna-s-2.1-free");
      expect(Object.keys(getModelOverrides()).length).toBe(6);
      resetModelOverrides();
      expect(getModelOverrides()).toEqual({});
      // defaults are restored
      expect(policyFor("analyzer").model).toBe("opencode/deepseek-v4-flash-free");
      expect(policyFor("coder").model).toBe("opencode/laguna-s-2.1-free");
    });
  });
});

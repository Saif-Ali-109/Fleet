import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { modelDefaults } from "../fleet/modelDefaults.ts";
import {
  allPolicies,
  getModelOverrides,
  loadModelOverrides,
  policyFor,
  resetModelOverrides,
  saveModelOverrides,
  setModelOverride,
} from "../models/modelPolicy.ts";
import { PROVIDER_NAMES, type Role } from "../types.ts";

describe("modelPolicy (v2 override store: {provider:{role:id}})", () => {
  const STRONG_ROLES: Role[] = ["analyzer", "planner", "reviewer"];
  const CHEAP_ROLES: Role[] = ["coder", "tester", "pr"];
  const ROLES: Role[] = [...STRONG_ROLES, ...CHEAP_ROLES];

  // Mutable override layer must not leak state between tests.
  beforeEach(() => resetModelOverrides());

  describe("policyFor defaults per provider/role (SPEC §5 tier table)", () => {
    it("defaults gemini strong roles to gemini-2.5-pro", () => {
      for (const role of STRONG_ROLES) {
        expect(policyFor(role, "gemini").model).toBe("gemini-2.5-pro");
      }
    });

    it("defaults gemini cheap roles to gemini-2.5-flash", () => {
      for (const role of CHEAP_ROLES) {
        expect(policyFor(role, "gemini").model).toBe("gemini-2.5-flash");
      }
    });

    it("defaults openrouter to the google/* mirror ids verbatim (no double prefix)", () => {
      for (const role of STRONG_ROLES) {
        expect(policyFor(role, "openrouter").model).toBe("google/gemini-2.5-pro");
      }
      for (const role of CHEAP_ROLES) {
        expect(policyFor(role, "openrouter").model).toBe("google/gemini-2.5-flash");
      }
    });

    it("defaults ollama to the qwen tier ids", () => {
      for (const role of STRONG_ROLES) {
        expect(policyFor(role, "ollama").model).toBe("qwen2.5:14b");
      }
      for (const role of CHEAP_ROLES) {
        expect(policyFor(role, "ollama").model).toBe("qwen2.5-coder:7b");
      }
    });

    it("defaults provider to gemini when omitted", () => {
      expect(policyFor("analyzer").model).toBe(policyFor("analyzer", "gemini").model);
    });

    it("keeps the low reasoning variant for thinking roles only", () => {
      for (const role of STRONG_ROLES) expect(policyFor(role, "gemini").variant).toBe("low");
      for (const role of CHEAP_ROLES) expect(policyFor(role, "gemini").variant).toBeUndefined();
    });

    it("falls back to the provider's tier default when an override is set", () => {
      setModelOverride("analyzer", "my-custom-id", "gemini");
      const p = policyFor("analyzer", "gemini");
      expect(p.model).toBe("my-custom-id");
      expect(p.fallbacks).toEqual(["gemini-2.5-pro"]);
    });

    it("carries no redundant fallback when no override is set", () => {
      expect(policyFor("coder", "ollama").fallbacks).toEqual([]);
    });
  });

  describe("env layer (SPEC D6: dashboard override > <ROLE>_MODEL_<PROVIDER> > tier default)", () => {
    const ENV_KEYS = ["ANALYZER_MODEL_OLLAMA", "CODER_MODEL_OLLAMA", "CODER_MODEL_GEMINI"];
    let savedEnv: Record<string, string | undefined>;

    beforeEach(() => {
      savedEnv = {};
      for (const k of ENV_KEYS) {
        savedEnv[k] = process.env[k];
        delete process.env[k];
      }
    });

    afterEach(() => {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    it("env var set → picked for that role+provider only", () => {
      process.env.CODER_MODEL_OLLAMA = "llama3.2:3b";
      expect(policyFor("coder", "ollama").model).toBe("llama3.2:3b");
      expect(policyFor("coder", "gemini").model).toBe(modelDefaults.gemini.coder);
      expect(policyFor("tester", "ollama").model).toBe(modelDefaults.ollama.tester);
    });

    it("env unset → tier default", () => {
      expect(policyFor("coder", "ollama").model).toBe(modelDefaults.ollama.coder);
      expect(policyFor("analyzer", "ollama").model).toBe(modelDefaults.ollama.analyzer);
    });

    it("dashboard override beats env", () => {
      process.env.CODER_MODEL_OLLAMA = "env-id";
      setModelOverride("coder", "dash-id", "ollama");
      expect(policyFor("coder", "ollama").model).toBe("dash-id");
    });

    it("env beats tier default and yields fallbacks=[tierDefault]", () => {
      process.env.ANALYZER_MODEL_OLLAMA = "env-strong";
      const p = policyFor("analyzer", "ollama");
      expect(p.model).toBe("env-strong");
      expect(p.fallbacks).toEqual([modelDefaults.ollama.analyzer]);
    });

    it("empty-string env value is treated as unset", () => {
      process.env.CODER_MODEL_OLLAMA = "";
      expect(policyFor("coder", "ollama").model).toBe(modelDefaults.ollama.coder);
      expect(policyFor("coder", "ollama").fallbacks).toEqual([]);
    });
  });

  describe("setModelOverride / getModelOverrides round-trip", () => {
    it("round-trips a per-provider role override", () => {
      setModelOverride("analyzer", "custom-pro", "openrouter");
      expect(getModelOverrides()).toEqual({ openrouter: { analyzer: "custom-pro" } });
      expect(policyFor("analyzer", "openrouter").model).toBe("custom-pro");
    });

    it("isolates overrides between providers and merges over defaults elsewhere", () => {
      setModelOverride("coder", "x", "ollama");
      expect(policyFor("coder", "ollama").model).toBe("x");
      expect(policyFor("coder", "gemini").model).toBe(modelDefaults.gemini.coder);
      expect(policyFor("coder", "openrouter").model).toBe(modelDefaults.openrouter.coder);
    });

    it("rejects empty/blank model ids", () => {
      expect(() => setModelOverride("analyzer", "", "gemini")).toThrow();
      expect(() => setModelOverride("analyzer", "   ", "gemini")).toThrow();
      expect(getModelOverrides()).toEqual({});
    });

    it("getModelOverrides returns a defensive copy", () => {
      setModelOverride("pr", "m1", "gemini");
      const snapshot = getModelOverrides();
      snapshot.gemini!.pr = "mutated";
      expect(getModelOverrides().gemini?.pr).toBe("m1");
    });

    it("resetModelOverrides clears every provider", () => {
      setModelOverride("analyzer", "opus", "openrouter");
      setModelOverride("coder", "q", "ollama");
      expect(Object.keys(getModelOverrides()).sort()).toEqual(["ollama", "openrouter"]);
      resetModelOverrides();
      expect(getModelOverrides()).toEqual({});
    });
  });

  describe("save/load persistence to manager/models.json-style paths", () => {
    let dir: string;
    let path: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "mp-v2-"));
      path = join(dir, "manager", "models.json"); // mirrors src/index.ts app-default layout
      mkdirSync(join(dir, "manager"), { recursive: true });
    });

    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("saves nested {provider:{role:id}} JSON and creates parent dirs", () => {
      setModelOverride("analyzer", "custom-a", "openrouter");
      setModelOverride("tester", "qwen-x", "ollama");
      saveModelOverrides(path);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
        openrouter: { analyzer: "custom-a" },
        ollama: { tester: "qwen-x" },
      });
    });

    it("loads overrides back into the store after a reset", () => {
      setModelOverride("reviewer", "rev-9", "gemini");
      saveModelOverrides(path);
      resetModelOverrides();
      loadModelOverrides(path);
      expect(getModelOverrides()).toEqual({ gemini: { reviewer: "rev-9" } });
      expect(policyFor("reviewer", "gemini").model).toBe("rev-9");
    });

    it("ignores unknown roles inside a known provider key", () => {
      writeFileSync(
        path,
        JSON.stringify({ gemini: { analyzer: "ok-id", notARole: "junk" } }),
        "utf8",
      );
      loadModelOverrides(path);
      expect(getModelOverrides()).toEqual({ gemini: { analyzer: "ok-id" } });
    });

    it("treats an unparseable file as an empty store without throwing", () => {
      writeFileSync(path, "{not json", "utf8");
      expect(() => loadModelOverrides(path)).not.toThrow();
      expect(getModelOverrides()).toEqual({});
    });

    it("self-seeds an EMPTY store when missing (defaults must not enter the override layer)", () => {
      expect(existsSync(path)).toBe(false);
      loadModelOverrides(path);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, "utf8")).toBe("{}\n");
      expect(getModelOverrides()).toEqual({});
    });

    it("regression: seeded-empty store keeps env above defaults across reboot", () => {
      const saved = process.env.ANALYZER_MODEL_OLLAMA;
      process.env.ANALYZER_MODEL_OLLAMA = "llama3.2:3b";
      try {
        // Boot 1: file missing → empty-store self-seed. Boot 2: reload the
        // regenerated file; the env var must still win over the §5 tier default.
        loadModelOverrides(path);
        loadModelOverrides(path);
        expect(policyFor("analyzer", "ollama").model).toBe("llama3.2:3b");
        expect(policyFor("analyzer", "ollama").fallbacks).toEqual([modelDefaults.ollama.analyzer]);
      } finally {
        if (saved === undefined) delete process.env.ANALYZER_MODEL_OLLAMA;
        else process.env.ANALYZER_MODEL_OLLAMA = saved;
      }
    });
  });

  describe("v1-key discard with single warning (log-once latch)", () => {
    it("discards legacy v1 per-backend keys and warns exactly once across loads", () => {
      const dir = mkdtempSync(join(tmpdir(), "mp-v1-"));
      const path = join(dir, "manager", "models.json");
      mkdirSync(join(dir, "manager"), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify({
          opencode: { analyzer: "legacy-free" },
          claude: { coder: "anthropic/claude-3.5-sonnet" },
          codex: { pr: "openai/gpt-4o-mini" },
          gemini: { analyzer: "legacy-free", planner: "kept-id" },
          openrouter: { coder: "anthropic/claude-3.5-sonnet" },
          ollama: { pr: "qwen2.5:7b" },
        }),
        "utf8",
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        loadModelOverrides(path);
        // v2 keys survive; v1 keys are dropped
        expect(getModelOverrides()).toEqual({
          gemini: { planner: "kept-id", analyzer: "legacy-free" },
          openrouter: { coder: "anthropic/claude-3.5-sonnet" },
          ollama: { pr: "qwen2.5:7b" },
        });
        loadModelOverrides(path);
        loadModelOverrides(path);
        // log-once latch: one warning total no matter how many loads re-see legacy keys
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("opencode, claude, codex"));
      } finally {
        warn.mockRestore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("does not warn on pure v2 files", () => {
      const dir = mkdtempSync(join(tmpdir(), "mp-pure-"));
      const path = join(dir, "models.json");
      writeFileSync(path, JSON.stringify({ ollama: { coder: "local-only" } }), "utf8");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        loadModelOverrides(path);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("allPolicies shape", () => {
    it("returns one policy per role × requested providers", () => {
      const policies = allPolicies(["gemini", "ollama"]);
      expect(policies).toHaveLength(12);
      for (const p of policies) {
        expect(ROLES).toContain(p.role);
        expect(typeof p.model).toBe("string");
        expect(p.model.length).toBeGreaterThan(0);
        expect(Array.isArray(p.fallbacks)).toBe(true);
      }
    });

    it("covers all three providers by default (18 entries)", () => {
      const policies = allPolicies();
      expect(policies).toHaveLength(PROVIDER_NAMES.length * ROLES.length);
      for (const provider of PROVIDER_NAMES) {
        for (const role of ROLES) {
          expect(policies.some((p) => p.role === role && p.model === policyFor(role, provider).model)).toBe(true);
        }
      }
    });
  });
});


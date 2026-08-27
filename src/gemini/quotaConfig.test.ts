import { afterEach, describe, expect, it } from "vitest";
import {
  GEMINI_QUOTA_DEFAULTS,
  assertGeminiModelChainConfiguration,
  geminiModelChain,
  geminiQuotaConfig,
  geminiRateLimitWaitMs,
  parseGeminiQuotaLimits,
  parseGeminiRateLimitModels,
  validateGeminiModelChainConfiguration,
  validateGeminiQuotaConfiguration,
} from "./quotaConfig.ts";
import { resetModelOverrides, setModelOverride } from "../models/modelPolicy.ts";

describe("Gemini quota configuration", () => {
  afterEach(() => {
    resetModelOverrides();
    delete process.env.GEMINI_RATE_LIMIT_WAIT_MS;
    delete process.env.GEMINI_RATE_LIMIT_MODELS;
  });

  it("ships the Gemini free-tier model defaults", () => {
    expect(GEMINI_QUOTA_DEFAULTS["gemini-2.5-pro"]).toEqual({ rpm: 5, tpm: 250_000, rpd: 100 });
    expect(GEMINI_QUOTA_DEFAULTS["gemini-2.5-flash"]).toEqual({ rpm: 10, tpm: 250_000, rpd: 250 });
    expect(GEMINI_QUOTA_DEFAULTS["gemini-3-flash-preview"]).toEqual({ rpm: 5, tpm: 250_000, rpd: 20 });
    expect(GEMINI_QUOTA_DEFAULTS["gemini-3.5-flash"]).toEqual({ rpm: 5, tpm: 250_000, rpd: 20 });
    expect(GEMINI_QUOTA_DEFAULTS["gemini-2.5-flash-lite"]).toEqual({ rpm: 15, tpm: 250_000, rpd: 1_000 });
    expect(GEMINI_QUOTA_DEFAULTS["gemini-3.5-flash-lite"]).toEqual({ rpm: 15, tpm: 250_000, rpd: 500 });
    expect(GEMINI_QUOTA_DEFAULTS["gemini-3.1-flash-lite"]).toEqual({ rpm: 15, tpm: 250_000, rpd: 500 });
  });

  it("keeps configured model ids exact", () => {
    expect(Object.keys(GEMINI_QUOTA_DEFAULTS)).toEqual(expect.arrayContaining([
      "gemini-3-flash-preview",
      "gemini-3.5-flash",
      "gemini-2.5-flash-lite",
      "gemini-3.5-flash-lite",
      "gemini-3.1-flash-lite",
    ]));
    setModelOverride("coder", "gemini-3.5-flash-lite-v2", "gemini");
    expect(validateGeminiQuotaConfiguration(["coder"], GEMINI_QUOTA_DEFAULTS)).toEqual([
      { role: "coder", model: "gemini-3.5-flash-lite-v2", message: "missing quota limits" },
    ]);
  });

  it("accepts arbitrary exact model ids through JSON overrides", () => {
    expect(parseGeminiQuotaLimits('{"custom":{"rpm":1,"tpm":2,"rpd":3}}')).toEqual({
      custom: { rpm: 1, tpm: 2, rpd: 3 },
    });
    setModelOverride("coder", "custom", "gemini");
    expect(validateGeminiQuotaConfiguration(["coder"], geminiQuotaConfig({ custom: { rpm: 1, tpm: 2, rpd: 3 } }))).toEqual([]);
  });

  it("reports missing limits for configured model overrides", () => {
    setModelOverride("coder", "custom", "gemini");
    expect(validateGeminiQuotaConfiguration(["coder"], { "gemini-2.5-flash": { rpm: 10, tpm: 250_000, rpd: 250 } })).toEqual([
      { role: "coder", model: "custom", message: "missing quota limits" },
    ]);
  });

  it.each([
    ["malformed", '{"custom":{"rpm":1}}'],
    ["invalid JSON", '{"custom"'],
    ["zero", '{"custom":{"rpm":0,"tpm":2,"rpd":3}}'],
    ["negative", '{"custom":{"rpm":-1,"tpm":2,"rpd":3}}'],
    ["fractional", '{"custom":{"rpm":1.5,"tpm":2,"rpd":3}}'],
  ])("rejects %s quota limits", (_label, raw) => {
    expect(() => parseGeminiQuotaLimits(raw)).toThrow();
  });

  it.each([
    ["zero", { rpm: 0, tpm: 2, rpd: 3 }],
    ["negative", { rpm: -1, tpm: 2, rpd: 3 }],
    ["fractional", { rpm: 1.5, tpm: 2, rpd: 3 }],
  ])("fails closed for %s configured limits", (_label, limit) => {
    setModelOverride("coder", "custom", "gemini");
    expect(validateGeminiQuotaConfiguration(["coder"], {
      custom: limit,
      "gemini-2.5-flash": { rpm: 1, tpm: 2, rpd: 3 },
    })).toEqual([
      { role: "coder", model: "custom", message: "quota limits must be positive integers" },
    ]);
  });

  it("validates both primary and fallback models", () => {
    process.env.GEMINI_RATE_LIMIT_MODELS = "gemini-2.5-flash";
    setModelOverride("coder", "custom-primary", "gemini");
    expect(validateGeminiQuotaConfiguration(["coder"], {
      "custom-primary": { rpm: 1, tpm: 2, rpd: 3 },
    })).toEqual([
      { role: "coder", model: "gemini-2.5-flash", message: "missing quota limits" },
    ]);
  });

  it("defaults and validates the wait ceiling", () => {
    expect(geminiRateLimitWaitMs()).toBe(120_000);
    process.env.GEMINI_RATE_LIMIT_WAIT_MS = "42";
    expect(geminiRateLimitWaitMs()).toBe(42);
    expect(() => geminiRateLimitWaitMs("zero")).toThrow();
  });
});

describe("Gemini rate-limit model chains", () => {
  const ROLES = ["analyzer", "planner", "coder", "tester", "reviewer", "pr"] as const;
  const POOL = ["gemini-2.5-flash", "gemini-3-flash-preview", "gemma-4-31b-it"];

  afterEach(() => {
    delete process.env.GEMINI_RATE_LIMIT_MODELS;
    for (const role of ROLES) delete process.env[`${role.toUpperCase()}_MODEL_GEMINI`];
  });

  function poolLimits() {
    return Object.fromEntries(POOL.map((model) => [model, { rpm: 1, tpm: 2, rpd: 3 }]));
  }

  it("parses GEMINI_RATE_LIMIT_MODELS into an ordered deduped pool", () => {
    delete process.env.GEMINI_RATE_LIMIT_MODELS;
    expect(parseGeminiRateLimitModels()).toEqual([]);
    process.env.GEMINI_RATE_LIMIT_MODELS = " gemini-2.5-flash ,, gemma-4-31b-it , gemini-2.5-flash ,";
    expect(parseGeminiRateLimitModels()).toEqual(["gemini-2.5-flash", "gemma-4-31b-it"]);
    expect(parseGeminiRateLimitModels("  m1 , ,m2,m1")).toEqual(["m1", "m2"]);
  });

  it("builds each role's chain from the pool without the primary", () => {
    process.env.GEMINI_RATE_LIMIT_MODELS = POOL.join(",");
    expect(geminiModelChain("coder", "gemini-3-flash-preview")).toEqual({
      model: "gemini-3-flash-preview",
      fallbacks: ["gemini-2.5-flash", "gemma-4-31b-it"],
    });
    expect(geminiModelChain("pr", "unlisted-model")).toEqual({
      model: "unlisted-model",
      fallbacks: [...POOL],
    });
  });

  it("accepts a fully populated chain configuration", () => {
    process.env.GEMINI_RATE_LIMIT_MODELS = POOL.join(",");
    for (const role of ROLES) process.env[`${role.toUpperCase()}_MODEL_GEMINI`] = "gemini-2.5-flash";
    expect(validateGeminiModelChainConfiguration(ROLES, poolLimits())).toEqual([]);
    expect(() => assertGeminiModelChainConfiguration(ROLES, poolLimits())).not.toThrow();
  });

  it("requires every <ROLE>_MODEL_GEMINI var", () => {
    process.env.GEMINI_RATE_LIMIT_MODELS = POOL.join(",");
    const limits = poolLimits();
    for (const role of ["planner", "coder", "tester", "reviewer", "pr"] as const) {
      process.env[`${role.toUpperCase()}_MODEL_GEMINI`] = "gemini-2.5-flash";
    }
    const missing = [{ role: "analyzer", model: "", message: "missing ANALYZER_MODEL_GEMINI" }];
    expect(validateGeminiModelChainConfiguration(ROLES, limits)).toEqual(missing);
    process.env.ANALYZER_MODEL_GEMINI = "   ";
    expect(validateGeminiModelChainConfiguration(ROLES, limits)).toEqual(missing);
    expect(() => assertGeminiModelChainConfiguration(ROLES, limits)).toThrow(/missing ANALYZER_MODEL_GEMINI/);
  });

  it("flags chain models lacking quota entries", () => {
    process.env.GEMINI_RATE_LIMIT_MODELS = `${POOL.join(",")},unlimited-model`;
    process.env.CODER_MODEL_GEMINI = "gemini-3-flash-preview";
    expect(validateGeminiModelChainConfiguration(["coder"], poolLimits())).toEqual([
      { role: "coder", model: "unlimited-model", message: "missing quota limits" },
    ]);
  });

  it("assert surfaces collected chain problems", () => {
    delete process.env.GEMINI_RATE_LIMIT_MODELS;
    expect(() => assertGeminiModelChainConfiguration(["analyzer"], {})).toThrow(
      `Invalid Gemini model chain configuration:\nanalyzer/: missing ANALYZER_MODEL_GEMINI`,
    );
  });
});

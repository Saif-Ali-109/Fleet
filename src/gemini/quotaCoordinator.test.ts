import { describe, expect, it } from "vitest";
import { GeminiQuotaCoordinator } from "./quotaCoordinator.ts";

describe("GeminiQuotaCoordinator", () => {
  it("reserves atomically and isolates exact models", () => {
    const c = new GeminiQuotaCoordinator({
      a: { rpm: 1, tpm: 100, rpd: 2 },
      b: { rpm: 1, tpm: 100, rpd: 2 },
    }, () => 1_000);
    expect(c.reserve({ provider: "gemini", model: "a", estimatedInputTokens: 10, maximumOutputTokens: 10 }).ok).toBe(true);
    const blocked = c.reserve({ provider: "gemini", model: "a", estimatedInputTokens: 10, maximumOutputTokens: 10 });
    expect(blocked).toMatchObject({ ok: false, block: "rpm", waitMs: 60_000 });
    expect(c.reserve({ provider: "gemini", model: "b", estimatedInputTokens: 10, maximumOutputTokens: 10 }).ok).toBe(true);
  });

  it("does not reserve partially when TPM blocks", () => {
    const c = new GeminiQuotaCoordinator({ a: { rpm: 2, tpm: 20, rpd: 2 } }, () => 1_000);
    expect(c.reserve({ provider: "gemini", model: "a", estimatedInputTokens: 15, maximumOutputTokens: 5 }).ok).toBe(true);
    expect(c.reserve({ provider: "gemini", model: "a", estimatedInputTokens: 1, maximumOutputTokens: 1 }).ok).toBe(false);
    expect(c.reserve({ provider: "gemini", model: "a", estimatedInputTokens: 1, maximumOutputTokens: 1 }).waitMs).toBeGreaterThan(0);
  });

  it("marks RPD exhaustion terminal and resets at UTC midnight", () => {
    let now = Date.UTC(2026, 0, 1, 23, 59, 59);
    const c = new GeminiQuotaCoordinator({ a: { rpm: 10, tpm: 100, rpd: 1 } }, () => now);
    expect(c.reserve({ provider: "gemini", model: "a", estimatedInputTokens: 1, maximumOutputTokens: 1 }).ok).toBe(true);
    expect(c.reserve({ provider: "gemini", model: "a", estimatedInputTokens: 1, maximumOutputTokens: 1 })).toMatchObject({ block: "rpd", terminal: true });
    now += 2_000;
    expect(c.modelState("a").quotaExhausted).toBe(false);
    expect(c.reserve({ provider: "gemini", model: "a", estimatedInputTokens: 1, maximumOutputTokens: 1 }).ok).toBe(true);
  });

  it("fails closed on invalid requests", () => {
    const c = new GeminiQuotaCoordinator({ a: { rpm: 1, tpm: 10, rpd: 1 } });
    expect(c.reserve({ provider: "gemini", model: "missing", estimatedInputTokens: 0, maximumOutputTokens: 0 })).toMatchObject({ ok: false, block: "error" });
    expect(c.reserve({ provider: "gemini", model: "a", estimatedInputTokens: 0, maximumOutputTokens: 0 })).toMatchObject({ ok: false, block: "error" });
  });
});

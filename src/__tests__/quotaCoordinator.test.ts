import { describe, it, expect } from "vitest";
import { GeminiQuotaCoordinator } from "../gemini/quotaCoordinator.ts";

const LIMITS = { "gemini-test-model": { rpm: 10, tpm: 1000, rpd: 3 } };

const reserve = (c: GeminiQuotaCoordinator, tokens = 10) =>
  c.checkAndReserve({ provider: "gemini", model: "gemini-test-model", estimatedInputTokens: tokens, maximumOutputTokens: 0 });

describe("GeminiQuotaCoordinator.resetAll", () => {
  it("clears rpd exhaustedUntil latches so reservations succeed again immediately", () => {
    let now = 1_000_000;
    const c = new GeminiQuotaCoordinator(LIMITS, () => now);
    for (let i = 0; i < LIMITS["gemini-test-model"]!.rpd; i++) {
      const r = reserve(c);
      expect(r.ok).toBe(true);
      now += 61_000;
    }
    const blocked = reserve(c);
    expect(blocked.ok).toBe(false);
    expect(blocked.terminal).toBe(true);
    expect(blocked.block).toBe("rpd");

    c.resetAll();

    now += 1_000;
    expect(reserve(c).ok).toBe(true);
    expect(c.modelState("gemini-test-model", now).quotaExhausted).toBe(false);
  });

  it("clears rolling rpm/tpm windows so a rate-limited model is usable again", () => {
    let now = 2_000_000;
    const c = new GeminiQuotaCoordinator({ "gemini-test-model": { rpm: 1, tpm: 100, rpd: 10 } }, () => now);
    expect(reserve(c).ok).toBe(true);
    const blocked = reserve(c);
    expect(blocked.ok).toBe(false);
    expect(blocked.block).toBe("rpm");
    expect(blocked.waitMs).toBeGreaterThan(0);

    now += 5_000;
    c.resetAll();

    expect(reserve(c).ok).toBe(true);
  });

  it("clears the failed latch tripped by an invalid request", () => {
    const now = 3_000_000;
    const c = new GeminiQuotaCoordinator(LIMITS, () => now);
    const bad = c.checkAndReserve({
      provider: "openrouter" as never,
      model: "gemini-test-model",
      estimatedInputTokens: 1,
      maximumOutputTokens: 1,
    });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("Invalid reservation request");
    // The failed latch poisons every later reservation…
    const poisoned = reserve(c);
    expect(poisoned.ok).toBe(false);
    expect(poisoned.error).toContain("unavailable");

    c.resetAll();

    expect(reserve(c).ok).toBe(true);
  });
});

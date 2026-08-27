import { afterEach, describe, expect, it, vi } from "vitest";
import { warnIfGeminiPoolUnset } from "../gemini/quotaConfig.ts";

const WARNING = "[quota] GEMINI_RATE_LIMIT_MODELS unset — every role runs a single-model chain (no fallback on limits)";

const prevPool = process.env.GEMINI_RATE_LIMIT_MODELS;

afterEach(() => {
  if (prevPool === undefined) delete process.env.GEMINI_RATE_LIMIT_MODELS;
  else process.env.GEMINI_RATE_LIMIT_MODELS = prevPool;
});

describe("warnIfGeminiPoolUnset", () => {
  it("warns exactly the unset-pool message when the pool is unset", () => {
    delete process.env.GEMINI_RATE_LIMIT_MODELS;
    const logger = vi.fn();
    warnIfGeminiPoolUnset(logger);
    expect(logger).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith(WARNING);
  });

  it("stays silent when the pool parses to at least one model", () => {
    process.env.GEMINI_RATE_LIMIT_MODELS = "gemini-2.5-flash, gemini-2.5-flash-lite";
    const logger = vi.fn();
    warnIfGeminiPoolUnset(logger);
    expect(logger).not.toHaveBeenCalled();
  });

  it("treats a blank pool as unset and never throws", () => {
    for (const value of ["", "   ", " , ,"]) {
      process.env.GEMINI_RATE_LIMIT_MODELS = value;
      const logger = vi.fn();
      expect(() => warnIfGeminiPoolUnset(logger)).not.toThrow();
      expect(logger).toHaveBeenCalledWith(WARNING);
    }
  });

  it("defaults to console.warn", () => {
    delete process.env.GEMINI_RATE_LIMIT_MODELS;
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() => warnIfGeminiPoolUnset()).not.toThrow();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(WARNING);
    } finally {
      spy.mockRestore();
    }
  });
});

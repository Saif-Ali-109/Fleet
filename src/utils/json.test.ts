import { describe, it, expect, vi } from "vitest";
import { extractJson } from "./json.ts";

describe("extractJson - H3 requirements", () => {
  it("returns null for raw slice > 100KB (length guard)", () => {
    const largeText = "{".repeat(100 * 1024 + 1) + "}";
    expect(extractJson(largeText)).toBeNull();
  });

  it("returns null for empty object {} (sanity check)", () => {
    expect(extractJson("{}")).toBeNull();
    expect(extractJson("text {} more")).toBeNull();
  });

  it("logs warning when salvage succeeds", () => {
    // Spy on console.warn
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const result = extractJson("{ \"a\": 1"); // truncated JSON that needs salvage
      expect(result).toEqual({ a: 1 });
      expect(warnSpy).toHaveBeenCalledWith("[json] Salvaged truncated JSON via extractJson");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not log warning when no salvage needed", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const result = extractJson('{"a": 1}');
      expect(result).toEqual({ a: 1 });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
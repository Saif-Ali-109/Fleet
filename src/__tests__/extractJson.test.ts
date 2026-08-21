import { describe, it, expect } from "vitest";
import { extractJson } from "../orchestrator.ts";
import type { FixSpec, Plan } from "../types.ts";

describe("extractJson", () => {
  it("parses a plain JSON object", () => {
    const result = extractJson<{ a: number }>('{"a": 1}');
    expect(result).toEqual({ a: 1 });
  });

  it("parses JSON wrapped in a ```json fence", () => {
    const text = "```json\n{\"summary\": \"done\"}\n```";
    const result = extractJson<{ summary: string }>(text);
    expect(result).toEqual({ summary: "done" });
  });

  it("parses JSON wrapped in a plain ``` fence", () => {
    const text = "```\n{\"summary\": \"done\"}\n```";
    const result = extractJson<{ summary: string }>(text);
    expect(result).toEqual({ summary: "done" });
  });

  it("parses JSON preceded by arbitrary prose", () => {
    const text = "Here is my analysis\n\n{\"rootCause\": \"null pointer\"}\nThat's it.";
    const result = extractJson<{ rootCause: string }>(text);
    expect(result).toEqual({ rootCause: "null pointer" });
  });

  it("parses nested objects correctly", () => {
    const result = extractJson<{ outer: { inner: string } }>(
      '{"outer": {"inner": "value"}}',
    );
    expect(result).toEqual({ outer: { inner: "value" } });
  });

  it("handles braces inside string values", () => {
    const result = extractJson<{ msg: string }>(
      '{"msg": "use {foo} inside strings"}',
    );
    expect(result).toEqual({ msg: "use {foo} inside strings" });
  });

  it("handles escaped quotes inside string values", () => {
    const result = extractJson<{ msg: string }>(
      '{"msg": "say \\"hi\\" now"}',
    );
    expect(result).toEqual({ msg: 'say "hi" now' });
  });

  it("handles backslash escapes inside string values", () => {
    const result = extractJson<{ msg: string }>(
      '{"msg": "a\\\\b\\\\c"}',
    );
    expect(result).toEqual({ msg: "a\\b\\c" });
  });

  it("returns null when there is no object in the text", () => {
    expect(extractJson('[1, 2, 3]')).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(extractJson("")).toBeNull();
  });

  it("returns null for whitespace-only text", () => {
    expect(extractJson("   \n\t  ")).toBeNull();
  });

  it("returns null for malformed JSON that cannot be fixed", () => {
    expect(extractJson("{bad json}")).toBeNull();
  });

  it("returns null when the slice is valid-looking but fails to parse", () => {
    expect(extractJson('{a: 1}')).toBeNull();
  });

  it("returns the first balanced object when multiple are present", () => {
    const text = '{"first": 1} {"second": 2}';
    const result = extractJson<{ first: number }>(text);
    expect(result).toEqual({ first: 1 });
  });

  it("parses a realistic FixSpec", () => {
    const text = `Here is the spec:
{"summary": "bug", "rootCause": "x", "suspectFiles": ["a.ts"], "affectedSymbols": ["f"], "reproduction": "r", "testStrategy": "t", "risks": ["low"], "confidence": "high"}`;
    const result = extractJson<FixSpec>(text);
    expect(result).toMatchObject({
      summary: "bug",
      rootCause: "x",
      suspectFiles: ["a.ts"],
      confidence: "high",
    });
  });

  it("parses a realistic Plan", () => {
    const text = `{"approach": "fix it", "steps": ["one"], "filesToChange": ["x"], "testsToAddOrUpdate": [], "acceptanceCriteria": ["done"], "outOfScope": []}`;
    const result = extractJson<Plan>(text);
    expect(result).toMatchObject({
      approach: "fix it",
      steps: ["one"],
      acceptanceCriteria: ["done"],
    });
  });

  describe("truncation handling (Free OpenCode Zen models cap output tokens)", () => {
    it("salvages an unclosed object by appending closing braces", () => {
      // A completed inner value, missing only the final closing brace.
      const result = extractJson<{ ok: boolean }>("{\"ok\": true");
      expect(result).toEqual({ ok: true });
    });

    it("salvages a deeply-nested object missing its closing braces", () => {
      // Two open braces, value complete — append "}}" to balance.
      const result = extractJson<{ outer: { inner: string } }>(
        '{"outer": {"inner": "value"',
      );
      expect(result).toEqual({ outer: { inner: "value" } });
    });

    it("salvages an object truncated mid-string-value by appending a closing quote + brace", () => {
      // The string value "the..." is cut; appending "}\"" closes the string then the object.
      const result = extractJson<{ reason: string }>(
        '{"reason": "the',
      );
      expect(result).toEqual({ reason: "the" });
    });

    it("salvages a FixSpec-shaped object whose last string value is truncated", () => {
      const text =
        '{"summary": "diag", "rootCause": "bad input and it was cut off here with no closing';
      const result = extractJson<{ summary: string; rootCause: string }>(text);
      expect(result).toMatchObject({
        summary: "diag",
        rootCause: "bad input and it was cut off here with no closing",
      });
    });

    it("salvages a nested object missing both inner and outer braces", () => {
      // depth=1 at end (inner { opened then closed by the salvage }, outer still open)
      const result = extractJson<{ a: { b: string } }>(
        '{"a": {"b": "x"',
      );
      expect(result).toEqual({ a: { b: "x" } });
    });

    it("salvages a complete value followed by a truncated string then missing brace", () => {
      const result = extractJson<{ a: string; b: string }>(
        '{"a": "ok", "b": "cut',
      );
      expect(result).toEqual({ a: "ok", b: "cut" });
    });

    it("salvages an object whose array value is truncated mid-string", () => {
      // The open string "b is closed by the '" ]}' tail, then ] and } balance the array and object.
      const result = extractJson<{ items: string[] }>(
        '{"items": ["a", "b',
      );
      expect(result).toEqual({ items: ["a", "b"] });
    });

    it("returns null when the truncated object has no recoverable value", () => {
      // depth=1 with an open key but a missing value — no tail can invent a value.
      expect(extractJson('{"a":')).toBeNull();
    });

    it("returns null for a structurally broken object", () => {
      expect(extractJson('{bad')).toBeNull();
    });
  });
});

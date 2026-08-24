import { describe, it, expect } from "vitest";
import { toJsonbParam } from "../db/audit.ts";

describe("toJsonbParam", () => {
  it("wraps strings as quoted jsonb scalars", () => {
    expect(toJsonbParam("hello")).toBe('"hello"');
  });

  it("stringifies markdown-ish tool output losslessly", () => {
    const md = "# Skill\n\n- step one";
    const param = toJsonbParam(md);
    expect(param).toBe(JSON.stringify(md));
    expect(JSON.parse(param as string)).toBe(md);
  });

  it("stringifies numbers as jsonb numeric scalars", () => {
    expect(toJsonbParam(42)).toBe("42");
    expect(toJsonbParam(3.14)).toBe("3.14");
  });

  it("stringifies booleans as jsonb scalar literals", () => {
    expect(toJsonbParam(true)).toBe("true");
    expect(toJsonbParam(false)).toBe("false");
  });

  it("roundtrips primitives to identical JS values via JSON.parse", () => {
    expect(JSON.parse(toJsonbParam("load_skill output") as string)).toBe("load_skill output");
    expect(JSON.parse(toJsonbParam(7) as string)).toBe(7);
    expect(JSON.parse(toJsonbParam(true) as string)).toBe(true);
  });

  it("passes objects through untouched for pg serialization", () => {
    const obj = { command: "ls", exitCode: 0 };
    expect(toJsonbParam(obj)).toBe(obj);
  });

  it("passes arrays through untouched for pg serialization", () => {
    const arr = ["a", 1, true];
    expect(toJsonbParam(arr)).toBe(arr);
  });

  it("maps null and undefined to null", () => {
    expect(toJsonbParam(null)).toBeNull();
    expect(toJsonbParam(undefined)).toBeNull();
  });
});

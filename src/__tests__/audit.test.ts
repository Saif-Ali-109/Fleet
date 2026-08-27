import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Pool } from "pg";
import { toJsonbParam, appendAuditEvent } from "../db/audit.ts";
import { signEvent } from "../sor/signer.ts";
import type { SorEvent } from "../sor/events.ts";

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

interface RecordedQuery {
  text: string;
  values?: unknown[];
}

function recordingPool(chainRow: { seq: string; hash: string }, recorded: RecordedQuery[]): Pool {
  const client = {
    query: async (...args: unknown[]) => {
      const q: RecordedQuery =
        typeof args[0] === "string"
          ? { text: args[0], values: args[1] as unknown[] | undefined }
          : (args[0] as RecordedQuery);
      recorded.push(q);
      return { rows: q.text.includes("FOR UPDATE") ? [chainRow] : [] };
    },
    release: () => {},
  };
  return { connect: async () => client } as unknown as Pool;
}

describe("appendAuditEvent payload bind", () => {
  const KEY = "test-signing-key";
  let savedKey: string | undefined;

  beforeEach(() => {
    savedKey = process.env.SOR_SIGNING_KEY;
    process.env.SOR_SIGNING_KEY = KEY;
    process.env.SOR_KEY_V1 = KEY;
  });

  afterEach(() => {
    if (savedKey === undefined) {
      delete process.env.SOR_SIGNING_KEY;
      delete process.env.SOR_KEY_V1;
    } else {
      process.env.SOR_SIGNING_KEY = savedKey;
      process.env.SOR_KEY_V1 = savedKey;
    }
  });

  function makeEvent(payload: Record<string, unknown>): SorEvent {
    return {
      run_id: null,
      event_type: "phase",
      actor: "manager",
      backend: null,
      tool_name: null,
      tool_input: null,
      tool_output: null,
      payload,
      created_at: "2026-08-24T00:00:00.000Z",
    };
  }

  it("wraps a primitive payload into its jsonb-safe stringified $9 bind", async () => {
    const recorded: RecordedQuery[] = [];
    const pool = recordingPool({ seq: "7", hash: "prev-hash" }, recorded);

    await appendAuditEvent(pool, makeEvent("primitive" as unknown as Record<string, unknown>));

    const insert = recorded.find((q) => q.text.startsWith("INSERT INTO audit_events"));
    expect(insert).toBeDefined();
    expect(insert?.values?.[8]).toBe(JSON.stringify("primitive"));
  });

  it("passes object payloads through untouched (bind identity preserved)", async () => {
    const recorded: RecordedQuery[] = [];
    const pool = recordingPool({ seq: "7", hash: "prev-hash" }, recorded);
    const payload = { phase: "start", status: "running" };

    await appendAuditEvent(pool, makeEvent(payload));

    const insert = recorded.find((q) => q.text.startsWith("INSERT INTO audit_events"));
    expect(insert?.values?.[8]).toBe(payload);
  });

  it("signs the raw event, not the coerced bind (hash-chain inputs unchanged)", async () => {
    const recorded: RecordedQuery[] = [];
    const pool = recordingPool({ seq: "7", hash: "prev-hash" }, recorded);
    const event = makeEvent("primitive" as unknown as Record<string, unknown>);

    await appendAuditEvent(pool, event);

    const insert = recorded.find((q) => q.text.startsWith("INSERT INTO audit_events"));
    expect(insert?.values?.[9]).toBe("prev-hash");
    expect(insert?.values?.[10]).toBe(signEvent(KEY, "prev-hash", { ...event, created_at: event.created_at }));
  });
});

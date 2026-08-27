import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pool } from "../db/client.ts";
import type { WorkforcePolicy } from "../workforce/policy.ts";
import { defaultPolicy } from "../workforce/policy.ts";
import {
  canHire,
  hireWorker,
  retireWorker,
  updateWorkerStatus,
} from "../workforce/hiring.ts";

const TEST_PREFIX = "test/";

function hirePolicy(roleName: string): WorkforcePolicy {
  return {
    ...defaultPolicy(),
    authorized_roles: [...defaultPolicy().authorized_roles, roleName],
  };
}

async function countRows(): Promise<number> {
  const result = await pool.query<{ count: string }>(
    "SELECT COUNT(*) AS count FROM worker_roles WHERE role_name LIKE $1",
    [`${TEST_PREFIX}%`]
  );
  const row = result.rows[0];
  return Number(row?.count ?? "0");
}

beforeAll(async () => {
  await pool.query(
    "DELETE FROM worker_roles WHERE role_name LIKE $1",
    [`${TEST_PREFIX}%`]
  );
});

afterAll(async () => {
  await pool.query(
    "DELETE FROM worker_roles WHERE role_name LIKE $1",
    [`${TEST_PREFIX}%`]
  );
});

describe("canHire", () => {
  it("allows an authorized role below limits", async () => {
    const result = await canHire(`${TEST_PREFIX}coder`, "opencode", hirePolicy(`${TEST_PREFIX}coder`));
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("rejects a role not in authorized_roles", async () => {
    const result = await canHire(`${TEST_PREFIX}unknown`, "opencode", defaultPolicy());
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("not authorized");
  });

  it("rejects a role in deny_hire_roles", async () => {
    const role = `${TEST_PREFIX}pr`;
    const policy: WorkforcePolicy = {
      ...hirePolicy(role),
      deny_hire_roles: [role],
    };
    const result = await canHire(role, "opencode", policy);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("denied");
  });

  it("rejects when max_per_backend is exceeded", async () => {
    const roleA = `${TEST_PREFIX}a`;
    const roleB = `${TEST_PREFIX}b`;
    const roleC = `${TEST_PREFIX}c`;
    await hireWorker(roleA, "opencode", "m", hirePolicy(roleA));
    await hireWorker(roleB, "opencode", "m", hirePolicy(roleB));
    const limited: WorkforcePolicy = {
      ...hirePolicy(roleC),
      max_concurrent_workers: 10,
      max_per_backend: { opencode: 2 },
    };
    const result = await canHire(roleC, "opencode", limited);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("backend");
  });

  it("rejects when max_concurrent_workers is exceeded", async () => {
    const roleX = `${TEST_PREFIX}x`;
    const roleY = `${TEST_PREFIX}y`;
    await hireWorker(roleX, "codex", "m", hirePolicy(roleX));
    const limited: WorkforcePolicy = {
      ...hirePolicy(roleY),
      max_concurrent_workers: 1,
    };
    const result = await canHire(roleY, "claude", limited);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("max concurrent");
  });
});

describe("hireWorker", () => {
  it("returns a UUID and inserts a pending row", async () => {
    const before = await countRows();
    const role = `${TEST_PREFIX}coder2`;
    const id = await hireWorker(role, "opencode", "opencode/m", hirePolicy(role));
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const result = await pool.query<{ role_name: string; status: string }>(
      "SELECT role_name, status FROM worker_roles WHERE role_id = $1",
      [id]
    );
    const row = result.rows[0];
    expect(row?.role_name).toBe(role);
    expect(row?.status).toBe("pending");
    expect(await countRows()).toBe(before + 1);
  });

  it("throws when the role cannot be hired", async () => {
    await expect(
      hireWorker(`${TEST_PREFIX}blocked`, "opencode", "opencode/m", defaultPolicy())
    ).rejects.toThrow("not authorized");
  });
});

describe("updateWorkerStatus and retireWorker", () => {
  it("updateWorkerStatus sets the status and stores output_path", async () => {
    const role = `${TEST_PREFIX}w`;
    const id = await hireWorker(role, "claude", "m", hirePolicy(role));
    await updateWorkerStatus(id, "success", "/tmp/out.txt");
    const result = await pool.query<{ status: string; permissions: unknown }>(
      "SELECT status, permissions FROM worker_roles WHERE role_id = $1",
      [id]
    );
    const row = result.rows[0];
    expect(row?.status).toBe("success");
    expect(row?.permissions).toEqual({ output_path: "/tmp/out.txt" });
  });

  it("updateWorkerStatus throws on an invalid status", async () => {
    const role = `${TEST_PREFIX}w2`;
    const id = await hireWorker(role, "claude", "m", hirePolicy(role));
    await expect(updateWorkerStatus(id, "bogus")).rejects.toThrow("Invalid worker status");
  });

  it("retireWorker sets status to retired", async () => {
    const role = `${TEST_PREFIX}w3`;
    const id = await hireWorker(role, "codex", "m", hirePolicy(role));
    await retireWorker(id);
    const result = await pool.query<{ status: string; ended_at: unknown }>(
      "SELECT status, ended_at FROM worker_roles WHERE role_id = $1",
      [id]
    );
    const row = result.rows[0];
    expect(row?.status).toBe("retired");
    expect(row?.ended_at).not.toBeNull();
  });
});
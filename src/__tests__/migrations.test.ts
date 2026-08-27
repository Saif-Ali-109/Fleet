import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");

function readUp(name: string): string {
  const content = readFileSync(path.join(MIGRATIONS_DIR, name), "utf-8");
  const upMatch = content.match(/--\s*UP:\s*\n([\s\S]*?)(?=\n--\s*DOWN:|$)/i);
  return upMatch && upMatch[1] ? upMatch[1].trim() : "";
}

describe("migrations", () => {
  it("006 widens the audit_events.backend check to legacy + provider backends", () => {
    const up = readUp("006_audit_backends.sql");
    expect(up).toContain("audit_events_backend_check");
    for (const backend of [
      "opencode",
      "claude",
      "codex",
      "gemini",
      "openrouter",
      "ollama",
    ]) {
      expect(up).toContain(`'${backend}'`);
    }
    expect(up).toMatch(/DROP CONSTRAINT IF EXISTS audit_events_backend_check/);
    expect(up).toMatch(/ADD CONSTRAINT audit_events_backend_check/);
  });

  it("006 down restores the original 004 backend constraint", () => {
    const content = readFileSync(
      path.join(MIGRATIONS_DIR, "006_audit_backends.sql"),
      "utf-8"
    );
    const downMatch = content.match(/--\s*DOWN:\s*\n([\s\S]*?)$/i);
    const down = downMatch && downMatch[1] ? downMatch[1].trim() : "";
    expect(down).toMatch(/ADD CONSTRAINT audit_events_backend_check/);
    for (const backend of ["opencode", "claude", "codex"]) {
      expect(down).toContain(`'${backend}'`);
    }
    for (const backend of ["gemini", "openrouter", "ollama"]) {
      expect(down).not.toContain(`'${backend}'`);
    }
  });

  it("008 widens the audit_events.event_type check to include quota lifecycle kinds", () => {
    const up = readUp("008_sor_quota_events.sql");
    expect(up).toContain("audit_events_event_type_check");
    for (const kind of [
      "tool_call",
      "wakeup",
      "phase",
      "registry_sync",
      "finalize",
      "model_switch",
      "model_recovered",
      "all_models_exhausted",
    ]) {
      expect(up).toContain(`'${kind}'`);
    }
    expect(up).toMatch(/DROP CONSTRAINT IF EXISTS audit_events_event_type_check/);
    expect(up).toMatch(/ADD CONSTRAINT audit_events_event_type_check/);
  });

  it("008 down restores the original 004 event_type constraint", () => {
    const content = readFileSync(
      path.join(MIGRATIONS_DIR, "008_sor_quota_events.sql"),
      "utf-8"
    );
    const downMatch = content.match(/--\s*DOWN:\s*\n([\s\S]*?)$/i);
    const down = downMatch && downMatch[1] ? downMatch[1].trim() : "";
    expect(down).toMatch(/ADD CONSTRAINT audit_events_event_type_check/);
    for (const kind of ["tool_call", "wakeup", "phase", "registry_sync", "finalize"]) {
      expect(down).toContain(`'${kind}'`);
    }
    for (const kind of ["model_switch", "model_recovered", "all_models_exhausted"]) {
      expect(down).not.toContain(`'${kind}'`);
    }
  });

  it("009 widens the audit_events.event_type check to include the pause lifecycle kinds", () => {
    const up = readUp("009_quota_pause_events.sql");
    expect(up).toContain("audit_events_event_type_check");
    for (const kind of [
      "tool_call",
      "wakeup",
      "phase",
      "registry_sync",
      "finalize",
      "model_switch",
      "model_recovered",
      "all_models_exhausted",
      "run_paused",
      "run_resumed",
    ]) {
      expect(up).toContain(`'${kind}'`);
    }
    expect(up).toMatch(/DROP CONSTRAINT IF EXISTS audit_events_event_type_check/);
    expect(up).toMatch(/ADD CONSTRAINT audit_events_event_type_check/);
  });

  it("009 down restores the 008 event_type constraint", () => {
    const content = readFileSync(
      path.join(MIGRATIONS_DIR, "009_quota_pause_events.sql"),
      "utf-8"
    );
    const downMatch = content.match(/--\s*DOWN:\s*\n([\s\S]*?)$/i);
    const down = downMatch && downMatch[1] ? downMatch[1].trim() : "";
    expect(down).toMatch(/ADD CONSTRAINT audit_events_event_type_check/);
    for (const kind of ["model_switch", "model_recovered", "all_models_exhausted"]) {
      expect(down).toContain(`'${kind}'`);
    }
    for (const kind of ["run_paused", "run_resumed"]) {
      expect(down).not.toContain(`'${kind}'`);
    }
  });

  it("010 widens the audit_events.event_type check to include reservation telemetry events", () => {
    const up = readUp("010_sor_telemetry_events.sql");
    expect(up).toContain("audit_events_event_type_check");
    for (const kind of [
      "tool_call",
      "wakeup",
      "phase",
      "registry_sync",
      "finalize",
      "model_switch",
      "model_recovered",
      "all_models_exhausted",
      "run_paused",
      "run_resumed",
      "reservation",
      "reservation_rejection",
      "provider_completion",
      "retry",
    ]) {
      expect(up).toContain(`'${kind}'`);
    }
    expect(up).toMatch(/DROP CONSTRAINT IF EXISTS audit_events_event_type_check/);
    expect(up).toMatch(/ADD CONSTRAINT audit_events_event_type_check/);
  });

  it("010 down restores the 009 event_type constraint", () => {
    const content = readFileSync(
      path.join(MIGRATIONS_DIR, "010_sor_telemetry_events.sql"),
      "utf-8"
    );
    const downMatch = content.match(/--\s*DOWN:\s*\n([\s\S]*?)$/i);
    const down = downMatch && downMatch[1] ? downMatch[1].trim() : "";
    expect(down).toMatch(/ADD CONSTRAINT audit_events_event_type_check/);
    for (const kind of ["tool_call", "wakeup", "phase", "registry_sync", "finalize", "model_switch", "model_recovered", "all_models_exhausted", "run_paused", "run_resumed"]) {
      expect(down).toContain(`'${kind}'`);
    }
    for (const kind of ["reservation", "reservation_rejection", "provider_completion", "retry"]) {
      expect(down).not.toContain(`'${kind}'`);
    }
  });

  it("migration files are numbered sequentially with no gaps", () => {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    expect(files.length).toBeGreaterThan(0);
    files.forEach((file, i) => {
      expect(file.startsWith(`${String(i + 1).padStart(3, "0")}_`)).toBe(true);
    });
    expect(files[files.length - 1]).toBe("012_sor_key_rotation.sql");
  });
});

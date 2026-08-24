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

  it("migration files are numbered sequentially with no gaps", () => {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    expect(files.length).toBeGreaterThan(0);
    files.forEach((file, i) => {
      expect(file.startsWith(`${String(i + 1).padStart(3, "0")}_`)).toBe(true);
    });
    expect(files[files.length - 1]).toBe("006_audit_backends.sql");
  });
});

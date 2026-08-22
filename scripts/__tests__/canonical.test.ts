import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MODELS_JSON, ROOT, loadCanonicalConfig } from "../lib/canonical.ts";

// Regression guard for the manager/ relocation: adapters must keep reading
// model overrides from manager/models.json. If this file drifts back to the
// repo root, loadCanonicalConfig silently falls back to frontmatter models
// and every generated .fleet config goes stale (CI check:config catches it,
// but only after a confusing diff — this test fails at the source).

describe("canonical config model overrides", () => {
  it("reads models.json from manager/, not the repo root", () => {
    expect(MODELS_JSON).toBe(join(ROOT, "manager", "models.json"));
    expect(existsSync(MODELS_JSON)).toBe(true);
    expect(existsSync(join(ROOT, "models.json"))).toBe(false);
  });

  it("applies every override in manager/models.json to the loaded roles", () => {
    const overrides = JSON.parse(readFileSync(MODELS_JSON, "utf8")) as Record<
      string,
      Record<string, string>
    >;
    const config = loadCanonicalConfig();
    const byRole = new Map(config.roles.map((r) => [r.role, r]));

    const backendField = {
      opencode: "model",
      claude: "claude_model",
      codex: "codex_model",
    } as const;

    let checked = 0;
    for (const [backend, roles] of Object.entries(overrides)) {
      const field = backendField[backend as keyof typeof backendField];
      expect(field, `unknown backend "${backend}" in models.json`).toBeDefined();
      for (const [role, model] of Object.entries(roles)) {
        const canonicalRole = byRole.get(role);
        expect(canonicalRole, `unknown role "${role}" in models.json`).toBeDefined();
        expect(canonicalRole?.[field]).toBe(model);
        checked++;
      }
    }
    // Guard against a future empty/stripped models.json making this test vacuous.
    expect(checked).toBeGreaterThan(0);
  });
});

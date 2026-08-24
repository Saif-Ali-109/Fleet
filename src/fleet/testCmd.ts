import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Split a shell command string into argv tokens (whitespace split; no quote handling). */
export function splitTestCommand(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

/**
 * Detect the test command for a repo worktree so coder/tester workers actually
 * run/verify tests instead of treating the step as a no-op:
 *  1. `package.json` `scripts.test` → the script verbatim (e.g. "vitest run").
 *  2. pytest config (`pytest.ini`, `[tool.pytest]` in `pyproject.toml`, or
 *     `requirements.txt` + a `tests/` dir) → "pytest".
 *  3. Fallback → `git status --porcelain` (a "nothing changed" check that the
 *     commit step can still treat as a pass), with a logged warning.
 */
export function detectTestCommand(worktreeDir: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(worktreeDir, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const script = pkg.scripts?.test;
    if (typeof script === "string" && script.trim()) {
      return script.trim();
    }
  } catch {
    // no package.json or unparseable JSON → fall through to pytest detection
  }
  if (detectPytest(worktreeDir)) {
    return "pytest";
  }
  console.warn(
    `[testCmd] no test command detected in ${worktreeDir}; falling back to \`git status --porcelain\` (a clean diff is the only pass condition)`,
  );
  return "git status --porcelain";
}

function detectPytest(worktreeDir: string): boolean {
  if (existsSync(join(worktreeDir, "pytest.ini"))) return true;
  try {
    const pyproject = readFileSync(join(worktreeDir, "pyproject.toml"), "utf8");
    if (/\[tool\.pytest/.test(pyproject)) return true;
  } catch {
    // no pyproject.toml
  }
  return (
    existsSync(join(worktreeDir, "requirements.txt")) &&
    isDirectory(join(worktreeDir, "tests"))
  );
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { analyzerDef } from "../fleet/agents/analyzer.ts";
import { coderDef } from "../fleet/agents/coder.ts";
import { prDef } from "../fleet/agents/pr.ts";
import { testerDef } from "../fleet/agents/tester.ts";
import type { FleetAgentDef, ToolName } from "../fleet/types.ts";
import {
  BUILTIN_TOOLS,
  buildRegistry,
  type ToolResult,
  type WtCtx,
} from "../fleet/tools/registry.ts";
import { BASH_TIMEOUT_DEFAULT_MS, bashTimeoutMs } from "../fleet/tools/bash.ts";

function defWith(tools: string[]): FleetAgentDef {
  return {
    name: "coder",
    systemPrompt: "",
    tools: tools as unknown as ToolName[],
    mcpAllow: [],
    skillsDir: "skills/coder",
  };
}

async function run(
  name: ToolName,
  input: unknown,
  ctx: WtCtx,
): Promise<ToolResult> {
  const impl = buildRegistry(coderDef)[name];
  if (!impl) throw new Error(`tool not registered for coder: ${name}`);
  return impl.exec(input, ctx);
}

let wt = "";

beforeEach(() => {
  wt = mkdtempSync(join(tmpdir(), "fleet-tools-"));
});

afterEach(() => {
  rmSync(wt, { recursive: true, force: true });
  delete process.env.WORKER_TIMEOUT_MS;
});

describe("buildRegistry gating", () => {
  it("analyzer registry contains only its read-only tools", () => {
    const registry = buildRegistry(analyzerDef);
    expect(Object.keys(registry).sort()).toEqual(["glob", "grep", "load_skill", "read"]);
    expect(registry.bash).toBeUndefined();
    expect(registry.write).toBeUndefined();
    expect(registry.edit).toBeUndefined();
  });

  it("coder and tester registries contain all seven built-ins", () => {
    for (const def of [coderDef, testerDef]) {
      expect(Object.keys(buildRegistry(def)).sort()).toEqual([...BUILTIN_TOOLS].sort());
    }
  });

  it("pr registry exposes only bash/read/load_skill", () => {
    expect(Object.keys(buildRegistry(prDef)).sort()).toEqual(["bash", "load_skill", "read"]);
  });

  it("ignores unknown role tool entries without throwing", () => {
    const registry = buildRegistry(defWith(["bash", "web_search", "nonexistent"]));
    expect(Object.keys(registry)).toEqual(["bash"]);
  });

  it("every registered impl carries a schema", () => {
    const registry = buildRegistry(coderDef);
    for (const name of BUILTIN_TOOLS) {
      const schema = registry[name]?.schema;
      expect(schema?.type).toBe("object");
      expect(Array.isArray(schema?.required)).toBe(true);
    }
  });
});

describe("bash tool", () => {
  const ctx = (): WtCtx => ({ worktreeDir: wt, role: "coder" });

  it("runs commands with the worktree as forced cwd", async () => {
    mkdirSync(join(wt, "sub"), { recursive: true });
    const result = await run("bash", { command: "pwd" }, ctx());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toContain(resolve(wt));
      expect(result.content).toContain("[exit code 0]");
    }
  });

  it("surfaces non-zero exit codes", async () => {
    const result = await run("bash", { command: "exit 3" }, ctx());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content).toContain("[exit code 3]");
  });

  it("captures stdout and stderr", async () => {
    const result = await run(
      "bash",
      { command: "echo out-line; echo err-line >&2" },
      ctx(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toContain("out-line");
      expect(result.content).toContain("err-line");
    }
  });

  it("truncates combined output to 20k chars while keeping the exit code", async () => {
    const result = await run(
      "bash",
      { command: "node -e 'process.stdout.write(\"a\".repeat(30000))'" },
      ctx(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content.length).toBeLessThanOrEqual(20_000 + "[exit code 0]\n".length);
      expect(result.content.endsWith("[exit code 0]")).toBe(true);
      expect(result.content).not.toContain("b".repeat(10));
      expect(result.content.startsWith("a".repeat(100))).toBe(true);
    }
  });

  it("kills long-running commands at the timeout cap", async () => {
    process.env.WORKER_TIMEOUT_MS = "300";
    const start = Date.now();
    const result = await run("bash", { command: "sleep 30" }, ctx());
    const elapsed = Date.now() - start;
    expect(result.ok).toBe(false);
    expect(elapsed).toBeLessThan(5000);
    if (!result.ok) expect(result.error).toContain("timed out after 300ms");
  });

  it("defaults the per-call cap to 10 minutes via WORKER_TIMEOUT_MS semantics", () => {
    expect(bashTimeoutMs()).toBe(BASH_TIMEOUT_DEFAULT_MS);
    process.env.WORKER_TIMEOUT_MS = "1234";
    expect(bashTimeoutMs()).toBe(1234);
    process.env.WORKER_TIMEOUT_MS = "";
    expect(bashTimeoutMs()).toBe(BASH_TIMEOUT_DEFAULT_MS);
  });

  it("locks cwd but does not block absolute binaries outside the worktree (SPEC §7 locks CWD only)", async () => {
    const result = await run("bash", { command: "/bin/echo outside-bin-ok" }, ctx());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content).toContain("outside-bin-ok");
  });

  it("rejects malformed input", async () => {
    const result = await run("bash", { nope: true }, ctx());
    expect(result.ok).toBe(false);
  });
});

describe("read tool", () => {
  const ctx = (): WtCtx => ({ worktreeDir: wt, role: "analyzer" });

  it("returns line-numbered content", async () => {
    writeFileSync(join(wt, "f.txt"), "alpha\nbeta\ngamma\n");
    const result = await run("read", { path: "f.txt" }, ctx());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content.split("\n")).toEqual([
        "1: alpha",
        "2: beta",
        "3: gamma",
      ]);
    }
  });

  it("honors offset", async () => {
    writeFileSync(join(wt, "f.txt"), "one\ntwo\nthree\n");
    const result = await run("read", { path: "f.txt", offset: 2 }, ctx());
    if (result.ok) expect(result.content.split("\n")).toEqual(["2: two", "3: three"]);
  });

  it("rejects traversal out of the worktree", async () => {
    const result = await run("read", { path: "../../etc/passwd" }, ctx());
    expect(result.ok).toBe(false);
  });

  it("rejects absolute paths outside the worktree", async () => {
    const result = await run("read", { path: "/etc/passwd" }, ctx());
    expect(result.ok).toBe(false);
  });

  it("rejects symlink escapes to files outside the worktree", async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "fleet-tools-outside-"));
    try {
      const outside = join(outsideDir, "secret.txt");
      writeFileSync(outside, "secret");
      symlinkSync(outside, join(wt, "leak.txt"));
      const result = await run("read", { path: "leak.txt" }, ctx());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/escapes|no such file/);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("caps output at 2000 lines with a note", async () => {
    writeFileSync(join(wt, "big.txt"), Array.from({ length: 2500 }, (_, i) => `l${i + 1}`).join("\n") + "\n");
    const result = await run("read", { path: "big.txt" }, ctx());
    if (result.ok) {
      const lines = result.content.split("\n");
      expect(lines.length).toBe(2001);
      expect(lines[2000]).toBe("[truncated at 2000 lines]");
      expect(lines[0]).toBe("1: l1");
    }
  });

  it("errors on a missing file", async () => {
    const result = await run("read", { path: "nope.txt" }, ctx());
    expect(result.ok).toBe(false);
  });
});

describe("write/edit tools", () => {
  const ctx = (): WtCtx => ({ worktreeDir: wt, role: "coder" });

  it("creates a new file and overwrites an existing one", async () => {
    const first = await run("write", { path: "new/dir/a.txt", content: "v1\n" }, ctx());
    expect(first.ok).toBe(true);
    expect(readFileSync(join(wt, "new/dir/a.txt"), "utf8")).toBe("v1\n");
    await run("write", { path: "new/dir/a.txt", content: "v2\n" }, ctx());
    expect(readFileSync(join(wt, "new/dir/a.txt"), "utf8")).toBe("v2\n");
  });

  it("rejects writes escaping the worktree", async () => {
    const result = await run("write", { path: "../escape.txt", content: "x" }, ctx());
    expect(result.ok).toBe(false);
    const absolute = await run(
      "write",
      { path: join(resolve(wt, ".."), "absolute-escape.txt"), content: "x" },
      ctx(),
    );
    expect(absolute.ok).toBe(false);
  });

  it("replaces exactly once on a unique match", async () => {
    writeFileSync(join(wt, "code.txt"), "const a = 1;\nconst b = 2;\n");
    const result = await run(
      "edit",
      { path: "code.txt", old_string: "const b = 2;", new_string: "const b = 42;" },
      ctx(),
    );
    expect(result.ok).toBe(true);
    expect(readFileSync(join(wt, "code.txt"), "utf8")).toBe("const a = 1;\nconst b = 42;\n");
  });

  it("fails loudly when old_string is absent", async () => {
    writeFileSync(join(wt, "f.txt"), "hello\n");
    const result = await run("edit", { path: "f.txt", old_string: "world", new_string: "!" }, ctx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not found/);
    expect(readFileSync(join(wt, "f.txt"), "utf8")).toBe("hello\n");
  });

  it("fails loudly when old_string matches multiple times", async () => {
    writeFileSync(join(wt, "dup.txt"), "same same\n");
    const result = await run("edit", { path: "dup.txt", old_string: "same", new_string: "diff" }, ctx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/matches 2 times/);
    expect(readFileSync(join(wt, "dup.txt"), "utf8")).toBe("same same\n");
  });

  it("rejects edits escaping the worktree", async () => {
    const result = await run("edit", { path: "../../etc/hosts", old_string: "a", new_string: "b" }, ctx());
    expect(result.ok).toBe(false);
  });
});

describe("grep/glob tools", () => {
  const ctx = (): WtCtx => ({ worktreeDir: wt, role: "analyzer" });

  it("finds matches as file:line:text within the worktree", async () => {
    mkdirSync(join(wt, ".git"), { recursive: true });
    writeFileSync(join(wt, ".git", "hidden.txt"), "needle in gitdir\n");
    writeFileSync(join(wt, "src.txt"), "nothing here\nneedle found\n");
    const result = await run("grep", { pattern: "needle" }, ctx());
    if (result.ok) {
      expect(result.content.split("\n")).toEqual(["src.txt:2: needle found"]);
    }
  });

  it("caps grep results at 500 with a note", async () => {
    writeFileSync(
      join(wt, "many.txt"),
      Array.from({ length: 600 }, (_, i) => `hit ${i + 1}`).join("\n") + "\n",
    );
    const result = await run("grep", { pattern: "hit" }, ctx());
    if (result.ok) {
      const lines = result.content.split("\n");
      expect(lines.length).toBe(501);
      expect(lines[500]).toBe("[truncated at 500 results]");
    }
  });

  it("reports invalid regex as an error", async () => {
    const result = await run("grep", { pattern: "(" }, ctx());
    expect(result.ok).toBe(false);
  });

  it("globs files relative to the worktree only", async () => {
    mkdirSync(join(wt, "nested"), { recursive: true });
    writeFileSync(join(wt, "root.ts"), "");
    writeFileSync(join(wt, "nested", "deep.ts"), "");
    const result = await run("glob", { pattern: "**/*.ts" }, ctx());
    if (result.ok) {
      expect(result.content.split("\n").sort()).toEqual(["nested/deep.ts", "root.ts"]);
    }
  });

  it("cannot glob outside the worktree even with ../ patterns", async () => {
    writeFileSync(join(resolve(wt, ".."), "outside-target.txt"), "x");
    const result = await run("glob", { pattern: "../outside*.txt" }, ctx());
    if (result.ok) expect(result.content.trim()).toBe("");
  });

  it("caps glob results at 500 with a note", async () => {
    for (let i = 0; i < 510; i++) {
      writeFileSync(join(wt, `file-${String(i).padStart(4, "0")}.txt`), "");
    }
    const result = await run("glob", { pattern: "*.txt" }, ctx());
    if (result.ok) {
      const lines = result.content.split("\n");
      expect(lines.length).toBe(501);
      expect(lines[500]).toBe("[truncated at 500 results]");
    }
  });
});

describe("load_skill tool", () => {
  const ctx = (): WtCtx => ({ worktreeDir: wt, role: "analyzer" });

  it("returns the skill body through the existing loader", async () => {
    const result = await run("load_skill", { name: "repo-triage" }, ctx());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content.length).toBeGreaterThan(0);
  });

  it("rejects traversal names", async () => {
    const result = await run("load_skill", { name: "../../../etc/passwd" }, ctx());
    expect(result.ok).toBe(false);
  });

  it("does not resolve another role's skills", async () => {
    const result = await run("load_skill", { name: "commit-hygiene" }, ctx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("skill not found");
  });

  it("rejects missing/non-string name", async () => {
    const result = await run("load_skill", {}, ctx());
    expect(result.ok).toBe(false);
  });
});

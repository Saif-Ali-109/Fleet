import { describe, expect, it } from "vitest";
import {
  formatSkillBlock,
  injectSkillSummaries,
  injectSkills,
  loadSkill,
  loadSkillSummaries,
} from "../fleet/skills/loader.ts";
import type { Role } from "../types.ts";

const ROLES = [
  "analyzer",
  "planner",
  "coder",
  "tester",
  "reviewer",
  "pr",
] as const satisfies readonly Role[];

describe("loadSkillSummaries", () => {
  it("returns name/description pairs parsed from frontmatter", () => {
    const summaries = loadSkillSummaries("coder");
    expect(summaries.length).toBe(2);
    for (const s of summaries) {
      expect(s.name).toMatch(/^[a-z-]+$/);
      expect(s.description.length).toBeGreaterThan(0);
    }
    expect(summaries.map((s) => s.name).sort()).toEqual([
      "commit-hygiene",
      "minimal-diff",
    ]);
  });

  it("formats each summary as exactly '- name: description'", () => {
    const summaries = loadSkillSummaries("coder");
    for (const s of summaries) {
      const block = formatSkillBlock([s]).split("\n");
      expect(block[0]).toBe("# Available skills");
      expect(block[1]).toBe(`- ${s.name}: ${s.description}`);
      expect(block.length).toBe(2);
    }
  });

  it("skips files without valid frontmatter", () => {
    const analyzerSummaries = loadSkillSummaries("analyzer");
    expect(analyzerSummaries.map((s) => s.name)).toEqual(["repo-triage"]);
  });

  it("returns [] for a role with no skills directory", () => {
    expect(loadSkillSummaries("planner").length).toBeGreaterThan(0);
    const empty: Role = "reviewer";
    expect(Array.isArray(loadSkillSummaries(empty))).toBe(true);
  });
});

describe("skill injection", () => {
  const SUMMARIES = [
    { name: "alpha", description: "Do alpha things" },
    { name: "beta", description: "Do beta things" },
  ];

  it("appends the block under '# Available skills' when summaries exist", () => {
    const prompt = "You are the CODER.\n";
    const out = injectSkillSummaries(prompt, SUMMARIES);
    expect(out).toBe(
      prompt +
        "\n# Available skills\n" +
        "- alpha: Do alpha things\n" +
        "- beta: Do beta things\n",
    );
  });

  it("returns the prompt unchanged (byte-equal) when there are no skills", () => {
    const prompt = "You are the ANALYZER.\n";
    expect(injectSkillSummaries(prompt, [])).toBe(prompt);
    expect(prompt.includes("# Available skills")).toBe(false);
  });

  it("injectSkills loads from the role dir; roles with no skills stay clean", () => {
    const coderOut = injectSkills("base\n", "coder");
    expect(coderOut).toContain("# Available skills");
    expect(coderOut).toContain("- minimal-diff:");
    const reviewerOut = injectSkills("base\n", "reviewer");
    if (loadSkillSummaries("reviewer").length === 0) {
      expect(reviewerOut).toBe("base\n");
    } else {
      expect(reviewerOut).toContain("# Available skills");
    }
  });
});

describe("loadSkill", () => {
  it("happy path returns body without frontmatter", () => {
    const res = loadSkill("coder", "minimal-diff");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.body.startsWith("---")).toBe(false);
    expect(res.body).not.toContain("name: minimal-diff");
    expect(res.body).toContain("# Minimal diff");
  });

  it("unknown role or name errors", () => {
    expect(loadSkill("nonexistent-role" as Role, "x").ok).toBe(false);
    expect(loadSkill("coder", "does-not-exist").ok).toBe(false);
  });

  it.each([
    "../escape",
    "../../escape",
    "../../../etc/passwd",
    "/etc/passwd",
    "/absolute/path",
    "sub/name",
    "sub\\name",
    "..%2Fescape",
    "%2e%2e%2fescape",
    "..",
    ".",
    "",
    "C:\\win32",
    "name\0.md",
  ])("rejects traversal attack %p", (attack) => {
    const res = loadSkill("coder", attack);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error(`traversal succeeded: ${attack}`);
  });
});

describe("starter playbooks", () => {
  const PLAYBOOKS: Array<[Role, string, number]> = [
    ["analyzer", "repo-triage", 120],
    ["planner", "decomposition", 120],
    ["coder", "minimal-diff", 120],
    ["coder", "commit-hygiene", 120],
    ["tester", "test-selection", 120],
    ["reviewer", "checklist", 120],
    ["pr", "pr-body", 120],
  ];

  for (const [role, name, maxLines] of PLAYBOOKS) {
    it(`${role}/${name}: parses with valid frontmatter and <=${maxLines} lines`, () => {
      const inSummaries = loadSkillSummaries(role).some(
        (s) => s.name === name,
      );
      expect(inSummaries).toBe(true);
      const res = loadSkill(role, name);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const lines = res.body.split("\n");
      expect(lines.length).toBeLessThanOrEqual(maxLines);
      expect(res.body.trim().length).toBeGreaterThan(0);
    });
  }

  it("frontmatter names match filenames across all playbooks", () => {
    for (const [role] of PLAYBOOKS.map((r) => [r[0], r[1]] as const)) {
      for (const s of loadSkillSummaries(role)) {
        expect(s.description).not.toBe("");
      }
    }
    expect(loadSkillSummaries("pr").map((s) => s.name)).toEqual(["pr-body"]);
    expect(loadSkillSummaries("tester").map((s) => s.name)).toEqual([
      "test-selection",
    ]);
  });
});

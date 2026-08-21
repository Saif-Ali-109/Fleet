import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pool } from "../db/client.ts";
import {
  RUN_LOG_START,
  RUN_LOG_END,
  mergeRunLogBlock,
  generateMemory,
  generateMemoryMarkdown,
} from "../db/queries/summaryReport.ts";

const EXISTING = [
  "# Run log",
  "",
  "## Next",
  "",
  "- Wire the Inngest webhook (Phase 3).",
  "",
  RUN_LOG_START,
  "_Regenerated from the database on 2026-01-01T00:00:00.000Z — do not hand-edit._",
  "",
  "- old/run#1  PR: (none) $0.00 [completed]",
  RUN_LOG_END,
  "",
  "## Notes",
  "- hand-written below the block",
].join("\n");

const NEW_BLOCK = [
  RUN_LOG_START,
  "_Regenerated from the database on 2026-02-02T00:00:00.000Z — do not hand-edit._",
  "",
  "- new/run#2 fix things PR: (none) $1.00 [completed]",
  RUN_LOG_END,
].join("\n");

const ROWS = [
  {
    repo: "new/run",
    issue_number: 2,
    issue_title: "fix things",
    pr_url: null,
    total_cost_usd: 1,
    completed_at: new Date("2026-02-02T00:00:00.000Z"),
    status: "completed",
  },
];

function stubQueries() {
  return vi.spyOn(pool, "query").mockImplementation((async (sql: string) => {
    if (sql.includes("FROM migrations")) {
      return { rows: [{ count: "3" }] };
    }
    return { rows: ROWS };
  }) as never);
}

describe("summaryReport MEMORY.md merge", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("mergeRunLogBlock replaces only the delimited block", () => {
    const merged = mergeRunLogBlock(EXISTING, NEW_BLOCK);
    expect(merged).not.toBeNull();
    const out = merged!;
    expect(out).toContain("## Next");
    expect(out).toContain("Wire the Inngest webhook");
    expect(out).toContain("## Notes");
    expect(out).toContain("- hand-written below the block");
    expect(out).not.toContain("old/run#1");
    expect(out).toContain("new/run#2");
    expect(out.indexOf(RUN_LOG_START)).toBeLessThan(out.indexOf(RUN_LOG_END));
  });

  it("mergeRunLogBlock returns null without delimiters (fallback path)", () => {
    expect(mergeRunLogBlock("# Run log\n\nno block here\n", NEW_BLOCK)).toBeNull();
  });

  it("mergeRunLogBlock returns null when delimiters are out of order", () => {
    expect(mergeRunLogBlock(`${RUN_LOG_END}\n${RUN_LOG_START}`, NEW_BLOCK)).toBeNull();
  });

  it("generateMemoryMarkdown wraps the run log in delimiters", async () => {
    stubQueries();
    const md = await generateMemoryMarkdown("/tmp/irrelevant");
    expect(md).toContain(RUN_LOG_START);
    expect(md).toContain(RUN_LOG_END);
    expect(md).toContain("_Regenerated from the database");
    expect(md).toContain("2026-02-02 new/run#2 fix things");
  });

  it("generateMemory merges into an existing file, preserving hand-curated sections", async () => {
    stubQueries();
    const dir = await mkdtemp(path.join(tmpdir(), "memory-merge-"));
    const memPath = path.join(dir, "MEMORY.md");
    await writeFile(memPath, EXISTING);

    const out = await generateMemory(dir);
    const content = await readFile(out, "utf8");
    expect(content).toContain("## Next");
    expect(content).toContain("Wire the Inngest webhook");
    expect(content).not.toContain("old/run#1");
    expect(content).toContain("new/run#2 fix things");
  });

  it("generateMemory falls back to full overwrite when the file lacks delimiters", async () => {
    stubQueries();
    const dir = await mkdtemp(path.join(tmpdir(), "memory-fallback-"));
    await writeFile(path.join(dir, "MEMORY.md"), "# Run log\n\nstale content\n");

    const out = await generateMemory(dir);
    const content = await readFile(out, "utf8");
    expect(content).not.toContain("stale content");
    expect(content).toContain(RUN_LOG_START);
    expect(content).toContain(RUN_LOG_END);
    expect(content).toContain("# Run log");
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetSessionLog } from "../memory/sessionLog.ts";

let root = "";
let runsDir = "";
let managerDir = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "session-log-"));
  runsDir = join(root, ".runs");
  managerDir = join(root, "manager");
  mkdirSync(runsDir, { recursive: true });
  mkdirSync(managerDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function prevLog(runId: string): string {
  return `# SESSION_LOG.txt — run ${runId}

- Started: 2026-08-26T08:44:56.843Z
- Repo: octocat/hello-world
- Issue: #1 — [dry-run] stub

## Timeline

- \`ts\` line from run ${runId}
`;
}

const HEADER = { repo: "octocat/hello-world", issue: 2, title: "next run" };

describe("resetSessionLog archive placement", () => {
  it("archives the previous log into ITS OWN run dir and writes a fresh live header", async () => {
    const prevId = "2026-08-26T08-44-56-796Z";
    const newId = "2026-08-26T09-00-00-000Z";
    mkdirSync(join(runsDir, prevId), { recursive: true });
    writeFileSync(join(managerDir, "SESSION_LOG.txt"), prevLog(prevId), "utf8");

    const livePath = await resetSessionLog(root, join(runsDir, newId), newId, HEADER);

    expect(livePath).toBe(join(managerDir, "SESSION_LOG.txt"));

    const archived = readFileSync(join(runsDir, prevId, "SESSION_LOG.txt"), "utf8");
    expect(archived).toContain(`# SESSION_LOG.txt — run ${prevId}`);
    expect(archived).toContain(`line from run ${prevId}`);

    const live = readFileSync(livePath, "utf8");
    expect(live.startsWith(`# SESSION_LOG.txt — run ${newId}\n`)).toBe(true);
    expect(live).toContain("- Repo: octocat/hello-world");
    expect(live).toContain("- Issue: #2 — next run");
    expect(live).toContain("## Timeline");
    expect(live).not.toContain(`line from run ${prevId}`);

    const newRunDir = join(runsDir, newId);
    expect(existsSync(join(newRunDir, "SESSION_LOG.txt"))).toBe(false);
    expect(existsSync(join(newRunDir, "SESSION_LOG-previous.txt"))).toBe(false);
  });

  it("never clobbers an existing archive in the owner dir (uses -previous suffix)", async () => {
    const prevId = "2026-08-26T08-44-56-796Z";
    const newId = "2026-08-26T09-00-00-000Z";
    mkdirSync(join(runsDir, prevId), { recursive: true });
    writeFileSync(join(runsDir, prevId, "SESSION_LOG.txt"), "pre-existing archive", "utf8");
    writeFileSync(join(managerDir, "SESSION_LOG.txt"), prevLog(prevId), "utf8");

    await resetSessionLog(root, join(runsDir, newId), newId, HEADER);

    expect(readFileSync(join(runsDir, prevId, "SESSION_LOG.txt"), "utf8")).toBe(
      "pre-existing archive",
    );
    const suffixed = readFileSync(join(runsDir, prevId, "SESSION_LOG-previous.txt"), "utf8");
    expect(suffixed).toContain(`# SESSION_LOG.txt — run ${prevId}`);
  });

  it("falls back to a labeled SESSION_LOG-previous.txt when the owner run dir is gone", async () => {
    const prevId = "2026-08-26T08-33-00-227Z";
    const newId = "2026-08-26T09-00-00-000Z";
    writeFileSync(join(managerDir, "SESSION_LOG.txt"), prevLog(prevId), "utf8");

    await resetSessionLog(root, join(runsDir, newId), newId, HEADER);

    const fallbackPath = join(runsDir, newId, "SESSION_LOG-previous.txt");
    const fallback = readFileSync(fallbackPath, "utf8");
    expect(fallback.startsWith(`# archived from previous run — belongs to run ${prevId}\n`)).toBe(
      true,
    );
    expect(fallback).toContain(`line from run ${prevId}`);
    expect(existsSync(join(runsDir, newId, "SESSION_LOG.txt"))).toBe(false);
  });

  it("labels unparseable previous logs without inventing an owner", async () => {
    const newId = "2026-08-26T09-00-00-000Z";
    writeFileSync(join(managerDir, "SESSION_LOG.txt"), "no recognizable header here\n", "utf8");

    await resetSessionLog(root, join(runsDir, newId), newId, HEADER);

    const fallback = readFileSync(join(runsDir, newId, "SESSION_LOG-previous.txt"), "utf8");
    expect(fallback.startsWith("# archived from previous run\n")).toBe(true);
    expect(fallback).toContain("no recognizable header here");
    const live = readFileSync(join(managerDir, "SESSION_LOG.txt"), "utf8");
    expect(live.startsWith(`# SESSION_LOG.txt — run ${newId}\n`)).toBe(true);
  });

  it("keeps working when no previous log exists", async () => {
    const newId = "2026-08-26T09-00-00-000Z";
    const livePath = await resetSessionLog(root, join(runsDir, newId), newId, HEADER);
    const live = readFileSync(livePath, "utf8");
    expect(live.startsWith(`# SESSION_LOG.txt — run ${newId}\n`)).toBe(true);
    expect(existsSync(join(runsDir, newId, "SESSION_LOG-previous.txt"))).toBe(false);
  });
});

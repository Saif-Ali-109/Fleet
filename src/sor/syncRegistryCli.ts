// CLI entry for `npm run sor:sync-registry` — sync the canonical agents/*.md
// into the agent_registry system-of-record table. Reads files relative to
// process.cwd() (the project root), parses frontmatter as metadata, computes a
// sha256 of the raw file bytes, and upserts one row per role.

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import matter from "gray-matter";
import { pool } from "../db/client.ts";
import { ensureChain, syncAgentRegistry, type AgentRegistryRow } from "../db/audit.ts";

const AGENTS_DIR = join(process.cwd(), "agents");
const GLOBAL_FILE = "_global.md";

async function main(): Promise<void> {
  const files = (await readdir(AGENTS_DIR))
    .filter((f) => f.endsWith(".md") && f !== GLOBAL_FILE)
    .sort();
  if (files.length === 0) {
    console.error(`[sor] no agent role files found in ${AGENTS_DIR}`);
    process.exit(1);
  }

  const rows: AgentRegistryRow[] = [];
  for (const file of files) {
    const raw = await readFile(join(AGENTS_DIR, file), "utf8");
    const { data, content } = matter(raw);
    rows.push({
      role: file.replace(/\.md$/, ""),
      metadata: data as Record<string, unknown>,
      rules: { prompt: content.trim() },
      source_hash: createHash("sha256").update(raw).digest("hex"),
    });
  }

  await ensureChain(pool);
  await syncAgentRegistry(pool, rows);
  console.log(`synced ${rows.length} roles`);
  await pool.end();
}

main().catch((err: unknown) => {
  console.error("[sor] sync-registry failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});

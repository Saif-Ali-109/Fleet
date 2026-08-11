/**
 * Single entrypoint for the whole config pipeline.
 *
 * agents/*.md is the one canonical source. Each registered adapter turns it
 * into one tool's native format. Add a new CLI agent by writing an adapter
 * (scripts/adapters/<tool>.ts implementing the Adapter type) and adding it
 * to ADAPTERS below — nothing else here changes.
 *
 * Usage:
 *   npx tsx scripts/generate-configs.ts          # writes every target file
 *   npx tsx scripts/generate-configs.ts --check   # exits 1 if anything is stale (CI)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadCanonicalConfig } from "./lib/canonical.js";
import type { Adapter } from "./lib/adapter.js";
import { opencodeAdapter } from "./adapters/opencode.js";
import { claudeCodeAdapter } from "./adapters/claude-code.js";
import { codexAdapter } from "./adapters/codex.js";

const ADAPTERS: { name: string; run: Adapter }[] = [
  { name: "opencode", run: opencodeAdapter },
  { name: "claude-code", run: claudeCodeAdapter },
  { name: "codex", run: codexAdapter },
];

function main() {
  const checkOnly = process.argv.includes("--check");
  const config = loadCanonicalConfig();

  const allFiles = ADAPTERS.flatMap(({ name, run }) => run(config).map((f) => ({ ...f, adapter: name })));

  if (checkOnly) {
    const stale: string[] = [];
    for (const file of allFiles) {
      const existing = existsSync(file.path) ? readFileSync(file.path, "utf8") : null;
      if (existing !== file.contents) stale.push(`[${file.adapter}] ${file.path}`);
    }
    if (stale.length > 0) {
      console.error(
        "The following generated files are stale (don't match agents/*.md):\n" +
          stale.map((s) => `  - ${s}`).join("\n") +
          "\n\nRun `npm run build:config` locally and commit the result.",
      );
      process.exit(1);
    }
    console.log(`All ${allFiles.length} generated files (${ADAPTERS.length} adapters) are up to date.`);
    return;
  }

  for (const file of allFiles) {
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.contents, "utf8");
  }
  console.log(`Wrote ${allFiles.length} files from ${ADAPTERS.length} adapters:`);
  for (const { name } of ADAPTERS) {
    const count = allFiles.filter((f) => f.adapter === name).length;
    console.log(`  ${name}: ${count} file(s)`);
  }
}

main();

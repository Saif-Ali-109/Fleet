// CLI entry for `npm run sor:verify` — replay-verify the signed System of
// Record hash chain against the DB and exit 0 (ok) / 1 (broken chain).

import { pool } from "../db/client.js";
import { runSorVerify } from "./verify.js";

let code: number;
try {
  code = await runSorVerify(pool);
} catch (err: unknown) {
  console.error("[sor] verify failed:", err instanceof Error ? err.message : String(err));
  code = 1;
}
await pool.end();
process.exit(code);

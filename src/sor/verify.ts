// CLI entry for `npm run sor:verify` — replay-verifies the signed System of
// Record hash chain against the DB and prints a readable report. The caller
// passes the pool in; this module never constructs one.

import type { Pool } from "pg";
import { verifyChain } from "../db/audit.ts";

/** Run verifyChain against the db pool, print a readable report (counts by event_type,
 *  total, ok/fail, first bad seq) to stdout, and return the process exit code (0 ok, 1 fail). */
export async function runSorVerify(pool: Pool): Promise<number> {
  const result = await verifyChain(pool);

  const typeNames = Object.keys(result.counts).sort();
  console.log("chain verification report");
  console.log("-------------------------");
  if (typeNames.length === 0) {
    console.log("(no audit events)");
  } else {
    for (const typeName of typeNames) {
      console.log(`${typeName}: ${result.counts[typeName]}`);
    }
  }
  console.log("total:", result.total);
  console.log("ok:", result.ok ? "yes" : "no");
  if (!result.ok) {
    console.log("first bad seq:", result.firstBadSeq);
  }

  return result.ok ? 0 : 1;
}
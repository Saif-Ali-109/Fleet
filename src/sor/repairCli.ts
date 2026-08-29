// CLI entry for `npm run sor:repair` — re-signs rows matching the current
// key_id in audit_events, rebuilding the hash chain for those rows in place
// (partial repair by key_id). Thin wrapper: owns pool + process.exit.
// The logic lives in repairChainForPool (repairChain.ts) so it stays
// unit-testable against an injected pool.

import { pool } from "../db/client.ts";
import { getCurrentKeyId } from "./keyRegistry.ts";
import { repairChainForPool } from "./repairChain.ts";

let code: number;
try {
	const currentKeyId = getCurrentKeyId();
	const report = await repairChainForPool(pool, currentKeyId);

	if (report.total === 0) {
		console.log(
			`no audit events found for key_id="${currentKeyId}" — nothing to repair`,
		);
		code = 0;
	} else {
		console.log(`chain repair report for key_id="${currentKeyId}"`);
		console.log("---------------------");
		console.log("total rows scanned:", report.total);
		console.log(
			"rows already correct:",
			report.total - report.needsUpdate - report.skipped,
		);
		if (report.skipped > 0) {
			console.log("rows skipped:", report.skipped);
		}
		console.log("rows needing update:", report.needsUpdate);
		if (report.needsUpdate > 0) {
			if (report.firstSeq !== undefined) {
				console.log("first seq to update:", report.firstSeq);
			}
			if (report.lastSeq !== undefined) {
				console.log("last seq to update:", report.lastSeq);
			}
			console.log("\napplying updates in a single transaction...");
			console.log("repair committed successfully");
		} else {
			console.log("chain is already valid — no changes made");
		}
		code = 0;
	}
} catch (err: unknown) {
	console.error(
		"[sor] repair failed:",
		err instanceof Error ? err.message : String(err),
	);
	code = 1;
}
await pool.end();
process.exit(code);
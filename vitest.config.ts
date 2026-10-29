import { defineConfig } from "vitest/config";
import {
	assertDedicatedTestDatabase,
	resolveTestDatabaseUrl,
} from "./scripts/testDb.ts";

// Tests always run against the dedicated `fleet_test` database, never the
// development database. This assignment deliberately OVERRIDES an inherited
// DATABASE_URL: production concurrency accounting counts active worker rows
// globally with no role-name filter, so unrelated rows in the dev database leak
// into test outcomes (this is what made hiring.test.ts depend on orphaned rows).
// `npm run test:db:setup` creates and migrates it.
const testDatabaseUrl = resolveTestDatabaseUrl();
assertDedicatedTestDatabase(testDatabaseUrl);
process.env.DATABASE_URL = testDatabaseUrl;

export default defineConfig({
	test: {
		globals: false,
		environment: "node",
		globalSetup: ["scripts/vitestGlobalSetup.ts"],
		include: [
			"src/**/*.test.ts",
			"src/**/__tests__/**/*.test.ts",
			"scripts/**/__tests__/**/*.test.ts",
		],
		typecheck: {
			enabled: false,
		},
		// The audit-chain suites (sor/__tests__/verify.test.ts and the gap-fix
		// repairChain/keyRotation files) TRUNCATE audit_events and reset
		// sor_chain on the same shared Postgres. Run test files sequentially so
		// chain-mutating files never race each other across processes.
		fileParallelism: false,
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html"],
			thresholds: {
				lines: 60,
			},
		},
	},
});

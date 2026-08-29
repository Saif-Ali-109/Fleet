import { defineConfig } from "vitest/config";

if (!process.env.DATABASE_URL) {
	process.env.DATABASE_URL =
		"postgresql://multiorm:multiorm@localhost:5432/multiorch?sslmode=disable";
}

export default defineConfig({
	test: {
		globals: false,
		environment: "node",
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

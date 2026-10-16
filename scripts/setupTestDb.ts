// Create and migrate the dedicated `fleet_test` database.
//
//   npm run test:db:setup            create if missing, then migrate
//   npm run test:db:setup -- --recreate   drop and recreate, then migrate
//
// Portable: the migration runner is spawned as a child process with DATABASE_URL
// in the child environment rather than using POSIX-only inline assignment, so
// this works on Windows shells too.
//
// Destructive behavior is opt-in via --recreate and hard-guarded to
// fleet_test; the default path never drops anything.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
	assertDedicatedTestDatabase,
	assertDestructiveTarget,
	dbNameOf,
	maintenanceUrl,
	resolveTestDatabaseUrl,
	TEST_DB_NAME,
} from "./testDb.ts";

const { Client } = pg;
const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const recreate = process.argv.includes("--recreate");

function runMigrations(databaseUrl: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[
				path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
				"src/db/migrate.ts",
				"up",
			],
			{
				cwd: repoRoot,
				env: { ...process.env, DATABASE_URL: databaseUrl },
				stdio: "inherit",
			},
		);
		child.on("error", reject);
		child.on("close", (code) =>
			code === 0
				? resolve()
				: reject(new Error(`migration runner exited with code ${code}`)),
		);
	});
}

async function main(): Promise<void> {
	const testUrl = resolveTestDatabaseUrl();
	assertDedicatedTestDatabase(testUrl);
	const name = dbNameOf(testUrl);

	const admin = new Client({ connectionString: maintenanceUrl(testUrl) });
	await admin.connect();
	try {
		const existing = await admin.query(
			"SELECT 1 FROM pg_database WHERE datname = $1",
			[name],
		);

		if (existing.rowCount === 0) {
			// CREATE DATABASE cannot be parameterized; the name is asserted above.
			await admin.query(`CREATE DATABASE "${name}"`);
			console.log(`[test-db] created database "${name}"`);
		} else if (recreate) {
			assertDestructiveTarget(testUrl);
			await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
			await admin.query(`CREATE DATABASE "${name}"`);
			console.log(`[test-db] recreated database "${name}"`);
		} else {
			console.log(`[test-db] database "${name}" already exists`);
		}
	} finally {
		await admin.end();
	}

	await runMigrations(testUrl);
	console.log(`[test-db] "${TEST_DB_NAME}" is ready`);
}

main().catch((err: unknown) => {
	console.error(`[test-db] ${(err as Error).message}`);
	process.exit(1);
});

// Vitest globalSetup: fail fast, and loudly, if the dedicated test database is
// missing, unreachable, or unmigrated.
//
// This runs before any test file, so a misconfigured environment surfaces as one
// clear message instead of dozens of confusing connection errors from individual
// suites. It also re-checks the live connection target rather than trusting
// configuration alone.

import pg from "pg";
import {
	assertDedicatedTestDatabase,
	resolveTestDatabaseUrl,
	TEST_DB_NAME,
} from "./testDb.ts";

const { Client } = pg;

export default async function setup(): Promise<void> {
	const testUrl = process.env.DATABASE_URL ?? resolveTestDatabaseUrl();
	assertDedicatedTestDatabase(testUrl);

	let client: InstanceType<typeof Client>;
	try {
		client = new Client({ connectionString: testUrl });
		await client.connect();
	} catch (err) {
		throw new Error(
			[
				`Cannot reach the dedicated test database "${TEST_DB_NAME}".`,
				`Underlying error: ${(err as Error).message}`,
				"",
				"Run `npm run test:db:setup` to create and migrate it.",
			].join("\n"),
		);
	}

	try {
		const live = await client.query("SELECT current_database() AS db");
		const liveName = live.rows[0]?.db;
		if (liveName !== TEST_DB_NAME) {
			throw new Error(
				`Connected to "${liveName}" but tests require "${TEST_DB_NAME}". Refusing to run against the wrong database.`,
			);
		}

		const migrated = await client.query(
			"SELECT count(*)::int AS n FROM migrations WHERE status = 'applied'",
		);
		const applied = migrated.rows[0]?.n ?? 0;
		if (applied === 0) {
			throw new Error(
				`Database "${liveName}" has no applied migrations. Run \`npm run test:db:setup\`.`,
			);
		}
		console.log(
			`[test-db] using "${liveName}" (${applied} migrations applied)`,
		);
	} finally {
		await client.end();
	}
}

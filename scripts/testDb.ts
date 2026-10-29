// Dedicated test-database resolution and safety guards.
//
// Database tests must never touch the development database. countActiveTotal()
// in src/workforce/hiring.ts counts active workers globally with no role-name
// filter, so a single orphaned row in the dev database changes test outcomes.
// Tests therefore always run against a dedicated `fleet_test` database, derived
// from DATABASE_URL by swapping the database name.

import { readFileSync } from "node:fs";

export const TEST_DB_NAME = "fleet_test";
const MAINTENANCE_DB = "postgres";

/**
 * Vitest does not load `.env` itself and the `npm test` scripts do not pass
 * `--env-file`, so an unset DATABASE_URL would otherwise look like a
 * misconfiguration.
 *
 * Only the two database variables are read. Deliberately NOT using
 * process.loadEnvFile(): that would inject the whole developer .env -- role
 * model pins, API keys, quota settings -- into the test process and silently
 * change what suites assert (model ids in particular). Database selection must
 * not perturb anything else. Existing environment variables always win, and a
 * missing file is not an error.
 */
function loadDotEnvIfNeeded(): void {
	if (process.env.DATABASE_URL || process.env.FLEET_TEST_DATABASE_URL) return;
	let contents: string;
	try {
		contents = readFileSync(".env", "utf8");
	} catch {
		return; // No .env — resolveTestDatabaseUrl reports the actionable error.
	}
	for (const line of contents.split("\n")) {
		const match = line.match(
			/^\s*(FLEET_TEST_DATABASE_URL|DATABASE_URL)\s*=\s*(.*?)\s*$/,
		);
		if (!match) continue;
		const value = match[2].replace(/^["']|["']$/g, "");
		if (value && !process.env[match[1]]) process.env[match[1]] = value;
	}
}

export function dbNameOf(connectionString: string): string {
	try {
		const name = decodeURIComponent(new URL(connectionString).pathname).replace(
			/^\//,
			"",
		);
		return name;
	} catch {
		throw new Error(
			`Could not parse a PostgreSQL URL (got ${JSON.stringify(connectionString)}).`,
		);
	}
}

export function resolveTestDatabaseUrl(): string {
	loadDotEnvIfNeeded();
	const base =
		process.env.FLEET_TEST_DATABASE_URL ||
		process.env.DATABASE_URL ||
		undefined;
	if (!base) {
		throw new Error(
			"Cannot resolve the test database: neither FLEET_TEST_DATABASE_URL nor " +
				"DATABASE_URL is set. Copy .env.example to .env, then run `npm run test:db:setup`.",
		);
	}
	if (!dbNameOf(base)) {
		throw new Error(
			`DATABASE_URL has no database name (got ${base}). Expected e.g. postgresql://user:pass@host:5432/fleet?sslmode=disable`,
		);
	}
	if (process.env.FLEET_TEST_DATABASE_URL) return base;
	const url = new URL(base);
	url.pathname = `/${TEST_DB_NAME}`;
	return url.toString();
}

/** Refuse to run unless the effective URL points at the dedicated test database. */
export function assertDedicatedTestDatabase(connectionString: string): void {
	const name = dbNameOf(connectionString);
	if (name === TEST_DB_NAME) return;
	throw new Error(
		[
			`Refusing to use database "${name}" for tests.`,
			`Tests must run against the dedicated "${TEST_DB_NAME}" database.`,
			"This guard exists because production concurrency accounting counts all",
			"active worker rows regardless of role name, so unrelated rows in a",
			"development or production database can change test results.",
			"",
			"Fix: run `npm run test:db:setup` to create and migrate it, or set",
			"FLEET_TEST_DATABASE_URL to point at a database named exactly",
			`"${TEST_DB_NAME}".`,
		].join("\n"),
	);
}

/** A connection to the maintenance DB on the same server, used to create the test DB. */
export function maintenanceUrl(connectionString: string): string {
	const url = new URL(connectionString);
	url.pathname = `/${MAINTENANCE_DB}`;
	return url.toString();
}

export function assertDestructiveTarget(connectionString: string): void {
	const name = dbNameOf(connectionString);
	if (name !== TEST_DB_NAME) {
		throw new Error(
			`Refusing destructive operation on database "${name}". Only "${TEST_DB_NAME}" may be dropped or recreated.`,
		);
	}
}

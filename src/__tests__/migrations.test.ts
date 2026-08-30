import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");

function readUp(name: string): string {
	const content = readFileSync(path.join(MIGRATIONS_DIR, name), "utf-8");
	const upMatch = content.match(/--\s*UP:\s*\n([\s\S]*?)(?=\n--\s*DOWN:|$)/i);
	return upMatch?.[1] ? upMatch[1].trim() : "";
}

describe("migrations", () => {
	it("006 widens the audit_events.backend check to legacy + provider backends", () => {
		const up = readUp("006_audit_backends.sql");
		expect(up).toContain("audit_events_backend_check");
		for (const backend of [
			"opencode",
			"claude",
			"codex",
			"gemini",
			"openrouter",
			"ollama",
		]) {
			expect(up).toContain(`'${backend}'`);
		}
		expect(up).toMatch(/DROP CONSTRAINT IF EXISTS audit_events_backend_check/);
		expect(up).toMatch(/ADD CONSTRAINT audit_events_backend_check/);
	});

	it("006 down restores the original 004 backend constraint", () => {
		const content = readFileSync(
			path.join(MIGRATIONS_DIR, "006_audit_backends.sql"),
			"utf-8",
		);
		const downMatch = content.match(/--\s*DOWN:\s*\n([\s\S]*?)$/i);
		const down = downMatch?.[1] ? downMatch[1].trim() : "";
		expect(down).toMatch(/ADD CONSTRAINT audit_events_backend_check/);
		for (const backend of ["opencode", "claude", "codex"]) {
			expect(down).toContain(`'${backend}'`);
		}
		for (const backend of ["gemini", "openrouter", "ollama"]) {
			expect(down).not.toContain(`'${backend}'`);
		}
	});

	it("008 widens the audit_events.event_type check to include quota lifecycle kinds", () => {
		const up = readUp("008_sor_quota_events.sql");
		expect(up).toContain("audit_events_event_type_check");
		for (const kind of [
			"tool_call",
			"wakeup",
			"phase",
			"registry_sync",
			"finalize",
			"model_switch",
			"model_recovered",
			"all_models_exhausted",
		]) {
			expect(up).toContain(`'${kind}'`);
		}
		expect(up).toMatch(
			/DROP CONSTRAINT IF EXISTS audit_events_event_type_check/,
		);
		expect(up).toMatch(/ADD CONSTRAINT audit_events_event_type_check/);
	});

	it("008 down restores the original 004 event_type constraint", () => {
		const content = readFileSync(
			path.join(MIGRATIONS_DIR, "008_sor_quota_events.sql"),
			"utf-8",
		);
		const downMatch = content.match(/--\s*DOWN:\s*\n([\s\S]*?)$/i);
		const down = downMatch?.[1] ? downMatch[1].trim() : "";
		expect(down).toMatch(/ADD CONSTRAINT audit_events_event_type_check/);
		for (const kind of [
			"tool_call",
			"wakeup",
			"phase",
			"registry_sync",
			"finalize",
		]) {
			expect(down).toContain(`'${kind}'`);
		}
		for (const kind of [
			"model_switch",
			"model_recovered",
			"all_models_exhausted",
		]) {
			expect(down).not.toContain(`'${kind}'`);
		}
	});

	it("009 widens the audit_events.event_type check to include the pause lifecycle kinds", () => {
		const up = readUp("009_quota_pause_events.sql");
		expect(up).toContain("audit_events_event_type_check");
		for (const kind of [
			"tool_call",
			"wakeup",
			"phase",
			"registry_sync",
			"finalize",
			"model_switch",
			"model_recovered",
			"all_models_exhausted",
			"run_paused",
			"run_resumed",
		]) {
			expect(up).toContain(`'${kind}'`);
		}
		expect(up).toMatch(
			/DROP CONSTRAINT IF EXISTS audit_events_event_type_check/,
		);
		expect(up).toMatch(/ADD CONSTRAINT audit_events_event_type_check/);
	});

	it("009 down restores the 008 event_type constraint", () => {
		const content = readFileSync(
			path.join(MIGRATIONS_DIR, "009_quota_pause_events.sql"),
			"utf-8",
		);
		const downMatch = content.match(/--\s*DOWN:\s*\n([\s\S]*?)$/i);
		const down = downMatch?.[1] ? downMatch[1].trim() : "";
		expect(down).toMatch(/ADD CONSTRAINT audit_events_event_type_check/);
		for (const kind of [
			"model_switch",
			"model_recovered",
			"all_models_exhausted",
		]) {
			expect(down).toContain(`'${kind}'`);
		}
		for (const kind of ["run_paused", "run_resumed"]) {
			expect(down).not.toContain(`'${kind}'`);
		}
	});

	it("010 widens the audit_events.event_type check to include reservation telemetry events", () => {
		const up = readUp("010_sor_telemetry_events.sql");
		expect(up).toContain("audit_events_event_type_check");
		for (const kind of [
			"tool_call",
			"wakeup",
			"phase",
			"registry_sync",
			"finalize",
			"model_switch",
			"model_recovered",
			"all_models_exhausted",
			"run_paused",
			"run_resumed",
			"reservation",
			"reservation_rejection",
			"provider_completion",
			"retry",
		]) {
			expect(up).toContain(`'${kind}'`);
		}
		expect(up).toMatch(
			/DROP CONSTRAINT IF EXISTS audit_events_event_type_check/,
		);
		expect(up).toMatch(/ADD CONSTRAINT audit_events_event_type_check/);
	});

	it("010 down restores the 009 event_type constraint", () => {
		const content = readFileSync(
			path.join(MIGRATIONS_DIR, "010_sor_telemetry_events.sql"),
			"utf-8",
		);
		const downMatch = content.match(/--\s*DOWN:\s*\n([\s\S]*?)$/i);
		const down = downMatch?.[1] ? downMatch[1].trim() : "";
		expect(down).toMatch(/ADD CONSTRAINT audit_events_event_type_check/);
		for (const kind of [
			"tool_call",
			"wakeup",
			"phase",
			"registry_sync",
			"finalize",
			"model_switch",
			"model_recovered",
			"all_models_exhausted",
			"run_paused",
			"run_resumed",
		]) {
			expect(down).toContain(`'${kind}'`);
		}
		for (const kind of [
			"reservation",
			"reservation_rejection",
			"provider_completion",
			"retry",
		]) {
			expect(down).not.toContain(`'${kind}'`);
		}
	});

	it("013 widens the audit_events.event_type check to include policy SoR event types", () => {
		const up = readUp("013_sor_policy_events.sql");
		expect(up).toContain("audit_events_event_type_check");
		for (const kind of [
			"tool_call",
			"wakeup",
			"phase",
			"registry_sync",
			"finalize",
			"model_switch",
			"model_recovered",
			"all_models_exhausted",
			"run_paused",
			"run_resumed",
			"reservation",
			"reservation_rejection",
			"provider_completion",
			"retry",
			"policy_state",
			"policy_sync",
			"policy_decision",
			"content_sync",
			"content_access",
			"context_update",
		]) {
			expect(up).toContain(`'${kind}'`);
		}
		expect(up).toMatch(
			/DROP CONSTRAINT IF EXISTS audit_events_event_type_check/,
		);
		expect(up).toMatch(/ADD CONSTRAINT audit_events_event_type_check/);
	});

	it("013 down restores the 010 event_type constraint", () => {
		const content = readFileSync(
			path.join(MIGRATIONS_DIR, "013_sor_policy_events.sql"),
			"utf-8",
		);
		const downMatch = content.match(/--\s*DOWN:\s*\n([\s\S]*?)$/i);
		const down = downMatch?.[1] ? downMatch[1].trim() : "";
		expect(down).toMatch(/ADD CONSTRAINT audit_events_event_type_check/);
		for (const kind of [
			"tool_call",
			"wakeup",
			"phase",
			"registry_sync",
			"finalize",
			"model_switch",
			"model_recovered",
			"all_models_exhausted",
			"run_paused",
			"run_resumed",
			"reservation",
			"reservation_rejection",
			"provider_completion",
			"retry",
		]) {
			expect(down).toContain(`'${kind}'`);
		}
		for (const kind of [
			"policy_state",
			"policy_sync",
			"policy_decision",
			"content_sync",
			"content_access",
			"context_update",
		]) {
			expect(down).not.toContain(`'${kind}'`);
		}
	});

	// P2.3: parity test — every VALID_TYPES entry must be in the 013 UP CHECK literal set
	it("TS VALID_TYPES is a subset of 013 UP CHECK (lockstep parity)", () => {
		const up = readUp("013_sor_policy_events.sql");
		// Extract the CHECK constraint's IN (...) list
		const checkMatch = up.match(/CHECK\s*\(event_type\s+IN\s*\(([\s\S]*?)\)\s*\)/i);
		if (!checkMatch) throw new Error("013 UP missing event_type CHECK");
		const checkList = checkMatch[1];
		if (checkList === undefined)
			throw new Error("013 UP event_type CHECK list is empty");
		// Parse quoted strings from the list
		const checkTypes = Array.from(
			checkList.matchAll(/'([^']+)'/g),
			(m) => m[1],
		);
		expect(checkList).toBeTruthy();
		expect(checkTypes.length).toBeGreaterThan(0);
		// Import VALID_TYPES from events.ts dynamically to avoid circular deps in test setup
		// We'll read it from the source file directly
		const eventsContent = readFileSync(
			path.resolve(process.cwd(), "src/sor/events.ts"),
			"utf-8",
		);
		const validTypesMatch = eventsContent.match(
			/const VALID_TYPES: readonly SorEventType\[\] = \[([\s\S]*?)\];/,
		);
		if (!validTypesMatch)
			throw new Error("013 parity test: VALID_TYPES not found in events.ts");
		const validTypesList = validTypesMatch[1];
		if (validTypesList === undefined)
			throw new Error("013 parity test: VALID_TYPES list is empty");
		const validTypes = Array.from(
			validTypesList.matchAll(/"([^"]+)"/g),
			(m) => m[1],
		);
		for (const vt of validTypes) {
			expect(checkTypes).toContain(vt);
		}
	});

	// P1.2: 014 adds the Policy SoR columns; DOWN drops both (backfill is in
	// ensurePolicyRegistry, tested at P5.2, not in SQL)
	it("014 adds nullable policy_hash + policy_version NOT NULL DEFAULT 1, DOWN drops both", () => {
		const up = readUp("014_agent_registry_policy.sql");
		expect(up).toMatch(/ALTER TABLE agent_registry\s+ADD COLUMN policy_hash TEXT/);
		expect(up).toMatch(
			/ADD COLUMN policy_version INTEGER NOT NULL DEFAULT 1/,
		);
		// Backfill is NOT in SQL — the hash must be computed by ensurePolicyRegistry
		expect(up).not.toMatch(/UPDATE\s+agent_registry/i);

		const content = readFileSync(
			path.join(MIGRATIONS_DIR, "014_agent_registry_policy.sql"),
			"utf-8",
		);
		const downMatch = content.match(/--\s*DOWN:\s*\n([\s\S]*?)$/i);
		const down = downMatch?.[1] ? downMatch[1].trim() : "";
		expect(down).toMatch(/ALTER TABLE agent_registry\s+DROP COLUMN policy_version/);
		expect(down).toMatch(/DROP COLUMN policy_hash/);
	});

	it("015 creates content_sor and content_chunks with pgvector (extension tolerated if absent)", () => {
		const up = readUp("015_content_sor.sql");
		expect(up).toContain("CREATE EXTENSION IF NOT EXISTS vector");
		expect(up).toContain("CREATE TABLE content_sor");
		expect(up).toMatch(/source_id\s+TEXT NOT NULL/);
		expect(up).toMatch(/namespace\s+TEXT NOT NULL DEFAULT 'fleet'/);
		expect(up).toMatch(/version\s+INTEGER NOT NULL/);
		expect(up).toMatch(/hash\s+TEXT NOT NULL/);
		expect(up).toMatch(/canonical_content\s+TEXT NOT NULL/);
		expect(up).toMatch(/metadata\s+JSONB NOT NULL DEFAULT '\{\}'/);
		expect(up).toMatch(/provenance\s+JSONB NOT NULL DEFAULT '\{\}'/);
		expect(up).toMatch(/status\s+TEXT NOT NULL DEFAULT 'active'/);
		expect(up).toMatch(/created_at\s+TIMESTAMPTZ NOT NULL DEFAULT now\(\)/);
		expect(up).toMatch(/PRIMARY KEY\s*\(\s*source_id\s*,\s*version\s*\)/);

		expect(up).toContain("CREATE TABLE content_chunks");
		expect(up).toMatch(/doc_id\s+TEXT NOT NULL/);
		expect(up).toMatch(/version\s+INTEGER NOT NULL/);
		expect(up).toMatch(/section\s+TEXT NOT NULL/);
		expect(up).toMatch(/chunk_index\s+INTEGER NOT NULL/);
		expect(up).toMatch(/text\s+TEXT NOT NULL/);
		expect(up).toMatch(/content_hash\s+TEXT NOT NULL/);
		expect(up).toMatch(/embedding\s+vector\(1536\)/);
		expect(up).toMatch(/ref\s+JSONB NOT NULL/);
		expect(up).toMatch(/PRIMARY KEY\s*\(\s*doc_id\s*,\s*version\s*,\s*chunk_index\s*\)/);

		expect(up).toContain("content_chunks_doc_version_idx");
		expect(up).toContain("content_chunks_text_fts_idx");
		expect(up).toContain("USING GIN");
		expect(up).toContain("to_tsvector");

		const content = readFileSync(
			path.join(MIGRATIONS_DIR, "015_content_sor.sql"),
			"utf-8",
		);
		const downMatch = content.match(/--\s*DOWN:\s*\n([\s\S]*?)$/i);
		const down = downMatch?.[1] ? downMatch[1].trim() : "";
		expect(down).toContain("DROP INDEX IF EXISTS content_chunks_text_fts_idx");
		expect(down).toContain("DROP INDEX IF EXISTS content_chunks_doc_version_idx");
		expect(down).toContain("DROP TABLE IF EXISTS content_chunks");
		expect(down).toContain("DROP TABLE IF EXISTS content_sor");
		expect(down).toContain("DROP EXTENSION IF EXISTS vector");

		// Note: if pgvector extension is not installed in the test DB, CREATE EXTENSION will fail.
		// This test only asserts the migration file content and serial-sequence tail pointer bumps.
		// A live DB round-trip is validated in integration tests where the extension is present.
	});

	it("migration files are numbered sequentially with no gaps", () => {
		const files = readdirSync(MIGRATIONS_DIR)
			.filter((f) => f.endsWith(".sql"))
			.sort();
		expect(files.length).toBeGreaterThan(0);
		files.forEach((file, i) => {
			expect(file.startsWith(`${String(i + 1).padStart(3, "0")}_`)).toBe(true);
		});
		expect(files[files.length - 1]).toBe("015_content_sor.sql");
	});

	it("each migration file's header NNN prefix matches its filename NNN (F5.1)", () => {
		const files = readdirSync(MIGRATIONS_DIR)
			.filter((f) => f.endsWith(".sql"))
			.sort();
		for (const file of files) {
			const nnn = file.slice(0, 3);
			const content = readFileSync(
				path.join(MIGRATIONS_DIR, file),
				"utf-8",
			);
			const headerMatch = content.match(/^--\s*migrations\/(\d{3})_/m);
			expect(headerMatch, `${file} has a migrations/NNN_ header`).toBeTruthy();
			expect(headerMatch?.[1]).toBe(nnn);
		}
	});
});

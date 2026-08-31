// Unit tests for the `sor:content:sync` CLI command (T7).
// No real DB, no real tokens, no actual worker fork — all I/O is faked.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	defaultEmbedFn,
	type EmbedFn,
	runSyncContent,
	walkMarkdownFiles,
} from "../cli/contentCommands.ts";
import { parseMarkdownSource } from "../fleet/content.ts";

// Stub the T5 write path so tests capture calls without touching the DB.
const { upsertMock } = vi.hoisted(() => ({ upsertMock: vi.fn() }));
vi.mock("../fleet/contentStore.ts", () => ({
	upsertDocument: upsertMock,
	emitContentSyncNonFatal: vi.fn(),
}));

interface RecordedQuery {
	text: string;
	values?: unknown[];
}

/** Recording pool: records every query; SELECTs resolve via `rowsFor`, writes are recorded. */
interface MockQueryResult {
	rows: unknown[];
	rowCount?: number;
}

function queryResult(
	text: string,
	rowsFor: (text: string) => unknown[],
): MockQueryResult {
	if (/\b(INSERT|UPDATE|DELETE)\b/i.test(text)) {
		return { rows: [], rowCount: 1 };
	}
	return { rows: rowsFor(text) };
}

function makePool(
	recorded: RecordedQuery[],
	rowsFor: (text: string) => unknown[] = () => [],
): Pool {
	const client = {
		query: async (
			text: string,
			values?: unknown[],
		): Promise<MockQueryResult> => {
			recorded.push({ text, values });
			return queryResult(text, rowsFor);
		},
		release: () => {},
	};
	return {
		connect: async () => client,
		query: async (
			text: string,
			values?: unknown[],
		): Promise<MockQueryResult> => {
			recorded.push({ text, values });
			return queryResult(text, rowsFor);
		},
	} as unknown as Pool;
}

describe("walkMarkdownFiles", () => {
	it("walks recursively and returns sorted .md rel paths", async () => {
		const dir = await mkdtemp(join(tmpdir(), "fleet-cmd-walk-"));
		try {
			await mkdir(join(dir, "sub"), { recursive: true });
			await writeFile(join(dir, "b.md"), "# b");
			await writeFile(join(dir, "sub", "a.md"), "# a");
			await writeFile(join(dir, "sub", "note.txt"), "not md");
			const files = await walkMarkdownFiles(dir);
			expect(files).toEqual(["b.md", "sub/a.md"]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("runSyncContent --dry-run", () => {
	let dir: string;
	const recorded: RecordedQuery[] = [];
	const lines: string[] = [];
	const embedSpy: EmbedFn = vi.fn(async () => []);

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "fleet-cmd-dry-"));
		await mkdir(join(dir, "nested"), { recursive: true });
		await writeFile(join(dir, "intro.md"), "# Intro\n\nHello world.\n");
		await writeFile(
			join(dir, "nested", "guide.md"),
			"# Guide\n\n## Setup\n\nBody.\n",
		);
		recorded.length = 0;
		lines.length = 0;
		upsertMock.mockReset();
		(embedSpy as ReturnType<typeof vi.fn>).mockClear();
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("prints per-file plan lines, aggregates counts, writes nothing and forks nothing", async () => {
		const pool = makePool(recorded);

		const report = await runSyncContent({
			pool,
			source: dir,
			dryRun: true,
			embedFn: embedSpy,
			log: (l) => lines.push(l),
		});

		// Correct per-file plan lines (file -> sourceId -> syncOutcome).
		expect(lines).toContain(
			"[plan] intro.md -> fleet|content|md:intro.md -> added",
		);
		expect(lines).toContain(
			"[plan] nested/guide.md -> fleet|content|md:nested/guide.md -> added",
		);

		// Aggregate counts.
		expect(report.counts.added).toBe(2);
		expect(report.counts.updated).toBe(0);
		expect(report.counts.unchanged).toBe(0);

		// NO pool writes (reads only), NO worker fork, NO upsert.
		for (const q of recorded) {
			expect(q.text).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
		}
		expect(embedSpy).not.toHaveBeenCalled();
		expect(upsertMock).not.toHaveBeenCalled();
	});
});

describe("runSyncContent non-dry-run", () => {
	let dir: string;
	const recorded: RecordedQuery[] = [];
	const lines: string[] = [];

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "fleet-cmd-sync-"));
		await writeFile(join(dir, "intro.md"), "# Intro\n\nHello world.\n");
		recorded.length = 0;
		lines.length = 0;
		upsertMock.mockReset();
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("added path: embeds then calls upsertDocument with parsed doc+chunks and records outcome", async () => {
		upsertMock.mockResolvedValue({ kind: "added", version: 1 });
		const embedFn: EmbedFn = async ({ texts }) => texts.map(() => [0.1, 0.2]);
		const pool = makePool(recorded); // no existing rows => added

		const report = await runSyncContent({
			pool,
			source: dir,
			provider: "gemini",
			model: "text-embedding-004",
			embedFn,
			log: (l) => lines.push(l),
		});

		expect(report.counts.added).toBe(1);
		expect(upsertMock).toHaveBeenCalledTimes(1);

		const doc = upsertMock.mock.calls[0]?.[1] as {
			sourceId: string;
			version: number;
		};
		// First upsert arg is the pool; second is the parsed doc.
		expect(upsertMock.mock.calls[0]?.[0]).toBe(pool);
		expect(doc.sourceId).toBe("fleet|content|md:intro.md");
		expect(doc.version).toBe(1);
		const chunks = upsertMock.mock.calls[0]?.[2] as {
			embedding: number[] | null;
		}[];
		expect(chunks.length).toBeGreaterThan(0);

		// Embeddings attached (non-null) since embedFn succeeded.
		const storedChunks = upsertMock.mock.calls[0]?.[2] as {
			embedding: number[] | null;
		}[];
		expect(storedChunks.every((c) => c.embedding?.length === 2)).toBe(true);
	});

	it("unchanged re-sync: calls upsertDocument with outcome unchanged, no duplicate write path", async () => {
		upsertMock.mockResolvedValue({ kind: "unchanged", version: 1 });
		// Pre-existing row whose hash matches the current content.
		const text = "# Intro\n\nHello world.\n";
		const parsed = parseMarkdownSource("intro.md", text, dir);
		const rowsFor = (q: string) =>
			q.includes("content_sor") && q.includes("source_id")
				? [
						{
							source_id: parsed.doc.sourceId,
							namespace: "fleet",
							version: 1,
							hash: parsed.doc.hash,
							status: "active",
							canonical_content: parsed.doc.canonicalContent,
							metadata: {},
							provenance: {},
						},
					]
				: [];
		const pool = makePool(recorded, rowsFor);
		const embedFn: EmbedFn = vi.fn(async () => []);

		const report = await runSyncContent({
			pool,
			source: dir,
			embedFn,
			log: (l) => lines.push(l),
		});

		expect(report.counts.unchanged).toBe(1);
		expect(report.counts.added).toBe(0);
		// upsertDocument still called (it emits the unchanged content_sync event).
		expect(upsertMock).toHaveBeenCalledTimes(1);
		expect(upsertMock.mock.calls[0]?.[1]).toMatchObject({
			sourceId: "fleet|content|md:intro.md",
			version: 1,
		});
		// Unchanged skips embedding — no re-embed of already-stored chunks.
		expect(embedFn).not.toHaveBeenCalled();
		// No writes issued by the CLI itself for an unchanged doc.
		for (const q of recorded) {
			expect(q.text).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
		}
	});

	it("embed unavailable (null): stores chunks with embedding null and warns", async () => {
		upsertMock.mockResolvedValue({ kind: "added", version: 1 });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const embedFn: EmbedFn = async () => null;
		const pool = makePool(recorded);

		await runSyncContent({
			pool,
			source: dir,
			embedFn,
			log: (l) => lines.push(l),
		});

		const storedChunks = upsertMock.mock.calls[0]?.[2] as {
			embedding: number[] | null;
		}[];
		expect(storedChunks.every((c) => c.embedding === null)).toBe(true);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});
});

describe("runSyncContent infra failure", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "fleet-cmd-infra-"));
		await writeFile(join(dir, "intro.md"), "# Intro\n\nHello.\n");
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("surfaces a DB (pool reject) error instead of swallowing it", async () => {
		const failPool = {
			query: async () => {
				throw new Error("connection refused");
			},
		} as unknown as Pool;

		await expect(
			runSyncContent({
				pool: failPool,
				source: dir,
				log: () => {},
			}),
		).rejects.toThrow(/connection refused/);
	});
});

// Ensure defaultEmbedFn shape is intact (imported for coverage of the default wiring).
describe("defaultEmbedFn", () => {
	it("is a function returning a promise", () => {
		const fn = defaultEmbedFn();
		expect(typeof fn).toBe("function");
		expect(typeof fn({ texts: [] }).then).toBe("function");
	});
});

// Fleet Content SoR — CLI command `sor:content:sync`.
// Manual markdown ingestion (spec §10.1) → content_sor/content_chunks via the
// T5 write path. Model calls live ONLY in the forked embed worker child
// (AGENTS.md); this module only forks and sends IPC.

import { type ChildProcess, fork } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import {
	type ContentChunk,
	type ContentDoc,
	parseMarkdownSource,
	type SyncKind,
	syncOutcome,
} from "../fleet/content.ts";
import { upsertDocument } from "../fleet/contentStore.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EMBED_ENTRY = resolve(__dirname, "../runtime/embed/main.ts");

export interface ContentSyncOptions {
	pool: Pool;
	/** Directory to walk recursively for `*.md` files. */
	source: string;
	provider?: string;
	model?: string;
	/** Plan-only mode: no DB writes, no worker fork, no tokens. */
	dryRun?: boolean;
	/** Injectable embedding fetcher (default: fork the T3 embed worker child). */
	embedFn?: EmbedFn;
	log?: (line: string) => void;
}

export type EmbedFn = (req: {
	texts: string[];
	provider?: string;
	model?: string;
}) => Promise<number[][] | null>;

export interface ContentFilePlan {
	relPath: string;
	sourceId: string;
	kind: SyncKind;
	version: number;
}

export interface ContentSyncReport {
	files: ContentFilePlan[];
	counts: Record<SyncKind, number>;
}

/** Recursively walk `dir`, returning sorted `.md` paths relative to `dir`. */
export async function walkMarkdownFiles(dir: string): Promise<string[]> {
	const root = resolve(dir);
	const out: string[] = [];
	async function walk(cur: string): Promise<void> {
		const entries = await readdir(cur, { withFileTypes: true });
		for (const entry of entries) {
			const p = join(cur, entry.name);
			if (entry.isDirectory()) {
				await walk(p);
			} else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
				out.push(relative(root, p));
			}
		}
	}
	await walk(root);
	return out.sort();
}

async function loadExistingDoc(
	pool: Pool,
	sourceId: string,
): Promise<ContentDoc | null> {
	const res = await pool.query<{
		source_id: string;
		namespace: string;
		version: number;
		hash: string;
		status: string;
		canonical_content: string;
		metadata: unknown;
		provenance: unknown;
	}>(
		`SELECT source_id, namespace, version, hash, status, canonical_content, metadata, provenance
		 FROM content_sor WHERE source_id = $1 ORDER BY version DESC LIMIT 1`,
		[sourceId],
	);
	const row = res.rows[0];
	if (!row) return null;
	return {
		sorType: "content",
		sourceId: row.source_id,
		namespace: row.namespace as "fleet",
		version: row.version,
		hash: row.hash,
		status: row.status as ContentDoc["status"],
		canonicalContent: row.canonical_content,
		metadata: (row.metadata ?? {}) as ContentDoc["metadata"],
		provenance: (row.provenance ?? {}) as ContentDoc["provenance"],
	};
}

/** Re-stamp a parsed doc/chunks for a chosen outcome version (added keeps 1). */
function withVersion(
	doc: ContentDoc,
	chunks: ContentChunk[],
	version: number,
): { doc: ContentDoc; chunks: ContentChunk[] } {
	const nextDoc: ContentDoc = { ...doc, version };
	const nextChunks: ContentChunk[] = chunks.map((c) => ({
		...c,
		docId: doc.sourceId,
		version,
		ref: { ...c.ref, version, hash: doc.hash },
	}));
	return { doc: nextDoc, chunks: nextChunks };
}

/** Attach embeddings to chunks; on null (unavailable) keep null + warn (FTS fallback, G5). */
async function withEmbeddings(
	embedFn: EmbedFn,
	chunks: ContentChunk[],
	provider?: string,
	model?: string,
): Promise<ContentChunk[]> {
	const vectors = await embedFn({
		texts: chunks.map((c) => c.text),
		provider,
		model,
	});
	if (vectors === null) {
		console.warn(
			"[sor] embed unavailable — storing chunks with embedding null (retrieval degrades to FTS)",
		);
		return chunks.map((c) => ({ ...c, embedding: null }));
	}
	if (vectors.length !== chunks.length) {
		console.warn(
			"[sor] embed count mismatch — storing chunks with embedding null",
		);
		return chunks.map((c) => ({ ...c, embedding: null }));
	}
	return chunks.map((c, i) => ({ ...c, embedding: vectors[i] ?? null }));
}

export async function runSyncContent(
	opts: ContentSyncOptions,
): Promise<ContentSyncReport> {
	const log = opts.log ?? ((line: string) => console.log(line));
	const dryRun = opts.dryRun === true;
	const embedFn = opts.embedFn ?? defaultEmbedFn();
	const root = resolve(opts.source);

	const report: ContentSyncReport = {
		files: [],
		counts: { added: 0, updated: 0, unchanged: 0, removed: 0 },
	};

	for (const relPath of await walkMarkdownFiles(opts.source)) {
		// Content-level issues (read/parse) are warnings that skip the file —
		// they must NOT fail the command (spec §10.8 unparseable => warning).
		let text: string;
		try {
			text = await readFile(join(root, relPath), "utf8");
		} catch (err) {
			log(
				`[skip] ${relPath}: cannot read (${
					err instanceof Error ? err.message : String(err)
				})`,
			);
			continue;
		}

		let doc: ContentDoc;
		let chunks: ContentChunk[];
		try {
			const parsed = parseMarkdownSource(relPath, text, root);
			doc = parsed.doc;
			chunks = parsed.chunks;
		} catch (err) {
			log(
				`[skip] ${relPath}: unparseable (${
					err instanceof Error ? err.message : String(err)
				})`,
			);
			continue;
		}

		const sourceId = doc.sourceId;
		// DB reads/writes happen outside the content try/catch so infra errors
		// (DB down) propagate and fail the command, per the task contract.
		const prev = await loadExistingDoc(opts.pool, sourceId);
		const outcome = syncOutcome(prev, doc);

		if (dryRun) {
			log(`[plan] ${relPath} -> ${sourceId} -> ${outcome.kind}`);
			report.files.push({
				relPath,
				sourceId,
				kind: outcome.kind,
				version: outcome.version,
			});
			report.counts[outcome.kind] = (report.counts[outcome.kind] ?? 0) + 1;
			continue;
		}

		// Only new/changed content needs embeddings — unchanged chunks already exist.
		let nextChunks = chunks;
		if (outcome.kind === "added" || outcome.kind === "updated") {
			nextChunks = await withEmbeddings(
				embedFn,
				chunks,
				opts.provider,
				opts.model,
			);
		}
		const staged = withVersion(doc, nextChunks, outcome.version);

		await upsertDocument(opts.pool, staged.doc, staged.chunks);

		log(`[sync] ${relPath} -> ${sourceId} -> ${outcome.kind}`);
		report.files.push({
			relPath,
			sourceId,
			kind: outcome.kind,
			version: outcome.version,
		});
		report.counts[outcome.kind] = (report.counts[outcome.kind] ?? 0) + 1;
	}

	return report;
}

/** Send one embed job to a spawned child and await its embed_result (null = unavailable). */
function sendEmbedJob(
	child: ChildProcess,
	texts: string[],
	provider?: string,
	model?: string,
): Promise<number[][] | null> {
	return new Promise((resolvePromise, reject) => {
		const onMessage = (msg: unknown) => {
			if (!msg || typeof msg !== "object") return;
			const m = msg as { type?: string; vectors?: number[][] | null };
			if (m.type === "embed_result") {
				cleanup();
				resolvePromise(m.vectors ?? null);
			}
		};
		const onError = (err: Error) => {
			cleanup();
			reject(err);
		};
		const onExit = (code: number | null) => {
			cleanup();
			reject(new Error(`embed worker exited before result (code ${code})`));
		};
		const cleanup = () => {
			child.off("message", onMessage);
			child.off("error", onError);
			child.off("exit", onExit);
		};
		child.on("message", onMessage);
		child.on("error", onError);
		child.on("exit", onExit);
		child.send({ type: "embed", texts, provider, model });
	});
}

/** Default embed fetcher: fork the T3 embed worker child and send IPC (no model calls here). */
export function defaultEmbedFn(): EmbedFn {
	return async (req) => {
		const child = fork(EMBED_ENTRY, {
			execPath: process.execPath,
			execArgv: [...process.execArgv, "--import", "tsx"],
			stdio: ["pipe", "pipe", "pipe", "ipc"],
			env: process.env,
		});
		try {
			return await sendEmbedJob(child, req.texts, req.provider, req.model);
		} catch (err) {
			console.warn(
				`[sor] embed worker failed: ${
					err instanceof Error ? err.message : String(err)
				} — storing chunks without embeddings`,
			);
			return null;
		} finally {
			try {
				child.kill();
			} catch {
				// ignore
			}
		}
	};
}

function parseArgs(args: string[]): {
	source: string | null;
	provider?: string;
	model?: string;
	dryRun: boolean;
} {
	let source: string | null = null;
	let provider: string | undefined;
	let model: string | undefined;
	let dryRun = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--source") {
			source = args[i + 1] ?? null;
			i++;
		} else if (a === "--provider") {
			provider = args[i + 1];
			i++;
		} else if (a === "--model") {
			model = args[i + 1];
			i++;
		} else if (a === "--dry-run") {
			dryRun = true;
		}
	}
	return { source, provider, model, dryRun };
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (args.source === null) {
		console.error(
			"usage: sor:content:sync --source <dir> [--provider <name>] [--model <name>] [--dry-run]",
		);
		process.exit(2);
	}

	let code = 0;
	try {
		const { pool } = await import("../db/client.ts");
		const report = await runSyncContent({
			pool,
			source: args.source,
			provider: args.provider,
			model: args.model,
			dryRun: args.dryRun,
		});
		console.log("\n[sor] content sync summary:");
		for (const kind of ["added", "updated", "unchanged"] as SyncKind[]) {
			console.log(`  ${kind}: ${report.counts[kind] ?? 0}`);
		}
		await pool.end();
	} catch (err) {
		console.error(
			"[sor] content sync failed:",
			err instanceof Error ? err.message : String(err),
		);
		code = 1;
	}
	process.exit(code);
}

const isEntry =
	process.argv[1] &&
	import.meta.url === new URL("file://" + process.argv[1]).href;

if (isEntry) {
	main();
}

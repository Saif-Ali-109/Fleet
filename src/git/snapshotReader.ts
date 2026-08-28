// Skeleton Snapshot reader — builds a lightweight file/symbol map of the repo
// (paths + symbol declaration headers only, bodies stripped) for the
// Skeleton Snapshots + Just-in-Time Context pipeline. Replaces the heavy
// full-repo snapshot (~7k tokens) with a map that targets <500 tokens.

import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type SymbolKind =
	| "class"
	| "interface"
	| "type"
	| "function"
	| "enum"
	| "default";

export interface SymbolDecl {
	name: string;
	kind: SymbolKind;
	line: number;
	/** The full declaration header line (truncated to SYMBOL_LINE_MAX). */
	header: string;
	/** Param list for functions, trimmed; empty for non-functions. */
	params: string;
}

export interface FileSkeleton {
	path: string;
	/** Cheap hint for the LLM; ".ts"/".py"/".md"/"" etc. */
	languageHint: string;
	symbols: SymbolDecl[];
	/** Non-null only when the read was capped; signals truncation to callers. */
	truncated: boolean;
}

export interface SkeletonMap {
	files: FileSkeleton[];
	totalFiles: number;
	/** true if the skeleton hit the char budget before consuming every file. */
	tokenBudgetExceeded: boolean;
}

const SKIP_DIRS = new Set([".git", ".runs", "node_modules", "dist"]);
/**
 * Parse an integer-ish env var: undefined/""/whitespace-only fall back to
 * `fallback` (set-but-empty must NOT defeat the default), any finite number is
 * honored, non-numeric values throw.
 */
export function envInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value)) {
		throw new Error(`env ${name}: invalid number value '${raw}'`);
	}
	return value;
}

/**
 * Cap on total collected symbol-header characters across the whole repo.
 * ~8000 chars of headers ≈ 2000 tokens, comfortably under the ~500-token target
 * (the LLM compresses structured code). Keeps the Planner's skeleton input tiny.
 */
export const SKELETON_CHAR_BUDGET = envInt("SNAPSHOT_SKELETON_CHARS", 8_000);
/** Cap on a single symbol header line recorded (avoids giant signatures). */
const SYMBOL_LINE_MAX = 200;
/** Max files we'll even consider, to bound git ls-files parsing cost. */
const MAX_FILES = 4096;
/** Stop scanning a file's lines after this many (headers cluster near the top). */
const SCAN_LINES_CAP = 120;

const TEXT_EXTS = new Set([
	".ts",
	".tsx",
	".ts",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".go",
	".rs",
	".java",
	".cpp",
	".cc",
	".c",
	".h",
	".hpp",
	".rb",
	".php",
	".sh",
	".bash",
	".zsh",
	".md",
	".json",
	".toml",
	".yaml",
	".yml",
	".html",
	".css",
	".scss",
]);

/** Run git with argv (no shell). Returns stdout trimmed. Local (non-exported). */
async function git(args: string[], cwd?: string): Promise<string> {
	const { stdout } = await exec("git", args, {
		cwd,
		maxBuffer: 32 * 1024 * 1024,
	});
	return stdout.trim();
}

/** Heuristic: treat a file as text (worth scanning) based on extension. */
function isScannableFile(path: string): boolean {
	const dot = path.lastIndexOf(".");
	if (dot <= 0) return false;
	return TEXT_EXTS.has(path.slice(dot).toLowerCase());
}

function skipTopDir(firstSegment: string): boolean {
	if (!firstSegment) return false;
	return firstSegment.startsWith(".") && firstSegment !== "."
		? true
		: SKIP_DIRS.has(firstSegment);
}

/** One regex per declaration style. Order: most specific first. */
const SYMBOL_PATTERNS: { kind: SymbolKind; re: (s: string) => number }[] = [];
function compilePatterns() {
	const patterns: { kind: SymbolKind; re: RegExp }[] = [
		{
			kind: "default",
			re: /^export\s+default\s+(?:class|function|interface|const|async\s+function|async\s+function\s*\*)/,
		},
		{
			kind: "class",
			re: /^(?:export\s+(?:default\s+)?|export\s+default\s+)?class\s+[A-Za-z_$][\w$]*[\s<{]/,
		},
		{
			kind: "interface",
			re: /^(?:export\s+)?interface\s+[A-Za-z_$][\w$]*[\s<{]/,
		},
		{ kind: "type", re: /^(?:export\s+)?type\s+[A-Za-z_$][\w$]*\s*=/ },
		{ kind: "enum", re: /^(?:export\s+)?enum\s+[A-Za-z_$][\w$]*[\s{]/ },
		{
			kind: "function",
			re: /^(?:export\s+(?:default\s+)?|export\s+default\s+)?(?:async\s+)?function(?:\s+\*)?\s*[A-Za-z_$][\w$]*\s*\(/,
		},
		// method-style shorthand inside an object/class, e.g. `  foo(` at line start
		{ kind: "function", re: /^\s+[a-zA-Z_$][\w$]*\s*\(([^)]*)\)\s*(?=:|\{)/ },
	];
	for (const p of patterns) {
		SYMBOL_PATTERNS.push({ kind: p.kind, re: (s: string) => s.search(p.re) });
	}
}
compilePatterns();

/** Extract the leading identifier name from a header line. */
export function symbolName(_kind: SymbolKind, header: string): string {
	const m =
		header.match(
			/(?:class|interface|type|enum|function)\s+([A-Za-z_$][\w$]*)/,
		) ??
		header.match(
			/export\s+default\s+(?:class|function|interface|const)\s+([A-Za-z_$][\w$]*)/,
		) ??
		header.match(/([A-Za-z_$][\w$]*)\s*\(/);
	return m ? (m[1] ?? "") : "";
}

/** Extract a trimmed param list for function-like headers. */
export function symbolParams(header: string): string {
	const m = header.match(/\(([^)]*)\)/);
	return m ? (m[1] ?? "").trim() : "";
}

/** Read the first SCAN_LINES_CAP lines of a file as text; null if binary/unreadable. */
async function readHeadLines(absPath: string): Promise<string[] | null> {
	let text: string;
	try {
		const buf = await readFile(absPath);
		if (buf.includes(0)) return null; // binary
		text = buf.toString("utf8", 0, Math.min(buf.length, SCAN_LINES_CAP * 1024));
	} catch {
		return null;
	}
	const lines = text.split("\n").slice(0, SCAN_LINES_CAP);
	return lines;
}

async function listTracked(dir: string): Promise<string[] | null> {
	try {
		const out = await git(
			[
				"ls-files",
				"-co",
				"--exclude-standard",
				"-z",
				"--max-count",
				String(MAX_FILES),
			],
			dir,
		);
		if (!out) return [];
		return out.split("\0").filter(Boolean);
	} catch {
		return null;
	}
}

async function listFallback(dir: string): Promise<string[]> {
	const out: string[] = [];
	const walk = async (rel: string): Promise<void> => {
		let entries: Dirent[];
		try {
			entries = await readdir(join(dir, rel), { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const full = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) {
				if (SKIP_DIRS.has(e.name)) continue;
				await walk(full);
			} else if (e.isFile() && isScannableFile(full)) {
				out.push(full);
			}
		}
	};
	await walk("");
	return out;
}

export async function buildSkeletonMap(
	worktreeDir: string,
): Promise<SkeletonMap> {
	const tracked =
		(await listTracked(worktreeDir)) ?? (await listFallback(worktreeDir));
	const scannable = tracked.filter(
		(f) => !skipTopDir(f.split("/")[0] ?? "") && isScannableFile(f),
	);
	const files: FileSkeleton[] = [];
	const totalFiles = scannable.length;
	let charBudget = SKELETON_CHAR_BUDGET;
	let tokenBudgetExceeded = false;

	for (const f of scannable) {
		const abs = join(worktreeDir, f);
		const lines = await readHeadLines(abs);
		if (!lines || lines.length === 0) continue;

		const skel: FileSkeleton = {
			path: f,
			languageHint: extHint(f),
			symbols: [],
			truncated: false,
		};
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i] ?? "";
			for (const { kind, re } of SYMBOL_PATTERNS) {
				if (re(line) !== -1) {
					const header = line.slice(0, SYMBOL_LINE_MAX);
					const name = symbolName(kind, header);
					if (!name) continue;
					skel.symbols.push({
						name,
						kind,
						line: i + 1,
						header,
						params: symbolParams(header),
					});
					break;
				}
			}
			// stop once we have a handful of symbols for this file
			if (skel.symbols.length >= 12) break;
		}
		if (skel.symbols.length > 0) {
			const sz = skel.symbols.reduce((a, s) => a + s.header.length + 1, 0);
			if (sz > charBudget) {
				tokenBudgetExceeded = true;
				break;
			}
			charBudget -= sz;
			files.push(skel);
		}
		if (files.length >= MAX_FILES) break;
	}

	return { files, totalFiles, tokenBudgetExceeded };
}

/** Compact symbol-header text for ONE requested file (JIT injection into Analyzer). */
export async function readSelectedFileSymbols(
	worktreeDir: string,
	filePath: string,
): Promise<string> {
	const abs = join(worktreeDir, filePath);
	const lines = await readHeadLines(abs);
	if (!lines) return `// File: ${filePath}\n// (unreadable or binary)`;
	const out: string[] = [`// File: ${filePath}`];
	let emitted = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		for (const { kind, re } of SYMBOL_PATTERNS) {
			if (re(line) !== -1) {
				const header = line.trim().slice(0, SYMBOL_LINE_MAX);
				if (symbolName(kind, header)) {
					out.push(header);
					emitted++;
				}
				break;
			}
		}
		if (emitted >= 20) break;
	}
	return out.join("\n");
}

function extHint(path: string): string {
	const dot = path.lastIndexOf(".");
	return dot > 0 ? path.slice(dot).toLowerCase() : "";
}

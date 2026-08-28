import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
	asRecord,
	asString,
	type ToolImpl,
	ToolInputError,
	type ToolResult,
} from "./common.ts";

export const SEARCH_RESULT_CAP = 500;
const SKIP_DIRS = new Set([".git", "node_modules"]);
const WALK_FILES_CACHE = new Map<string, string[]>();

function fail(err: unknown): ToolResult {
	return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

function walkFiles(root: string): string[] {
	const cached = WALK_FILES_CACHE.get(root);
	if (cached !== undefined) {
		return cached;
	}

	const out: string[] = [];
	const visit = (dir: string): void => {
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (SKIP_DIRS.has(entry.name)) continue;
				visit(full);
			} else if (entry.isFile()) {
				out.push(full);
			}
		}
	};
	visit(root);

	WALK_FILES_CACHE.set(root, out);
	return out;
}

function globToRegex(pattern: string): RegExp {
	let source = "";
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern.charAt(i);
		if (ch === "*") {
			if (pattern.charAt(i + 1) === "*") {
				while (pattern.charAt(i + 1) === "*") i++;
				if (pattern.charAt(i + 1) === "/") {
					i++;
					source += "(?:.*/)?";
				} else {
					source += ".*";
				}
			} else {
				source += "[^/]*";
			}
		} else if (ch === "?") {
			source += "[^/]";
		} else {
			source += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(`^${source}$`);
}

export const grepTool: ToolImpl = {
	schema: {
		type: "object",
		properties: {
			pattern: { type: "string", description: "regular expression to match" },
		},
		required: ["pattern"],
		additionalProperties: false,
	},
	async exec(input, ctx): Promise<ToolResult> {
		let pattern: string;
		try {
			pattern = asString(asRecord(input), "pattern");
		} catch (err) {
			if (!(err instanceof ToolInputError)) throw err;
			return fail(err);
		}
		let regex: RegExp;
		try {
			regex = new RegExp(pattern);
		} catch (err) {
			return {
				ok: false,
				error: `invalid regex: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
		const results: string[] = [];
		let truncated = false;
		for (const file of walkFiles(ctx.worktreeDir)) {
			if (truncated) break;
			let text: string;
			try {
				text = readFileSync(file, "utf8");
			} catch {
				continue;
			}
			const lines = text.split("\n");
			for (let i = 0; i < lines.length; i++) {
				if (!regex.test(lines[i] as string)) continue;
				results.push(
					`${relative(ctx.worktreeDir, file)}:${i + 1}: ${(lines[i] as string).trim()}`,
				);
				if (results.length >= SEARCH_RESULT_CAP) {
					truncated = true;
					break;
				}
			}
		}
		return {
			ok: true,
			content:
				results.join("\n") +
				(truncated ? `\n[truncated at ${SEARCH_RESULT_CAP} results]` : ""),
		};
	},
};

export const globTool: ToolImpl = {
	schema: {
		type: "object",
		properties: {
			pattern: {
				type: "string",
				description: "glob pattern relative to the worktree",
			},
		},
		required: ["pattern"],
		additionalProperties: false,
	},
	async exec(input, ctx): Promise<ToolResult> {
		let pattern: string;
		try {
			pattern = asString(asRecord(input), "pattern");
		} catch (err) {
			if (!(err instanceof ToolInputError)) throw err;
			return fail(err);
		}
		let regex: RegExp;
		try {
			regex = globToRegex(pattern);
		} catch (err) {
			return {
				ok: false,
				error: `invalid glob: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
		const results: string[] = [];
		let truncated = false;
		for (const file of walkFiles(ctx.worktreeDir).sort()) {
			const rel = relative(ctx.worktreeDir, file).split("\\").join("/");
			const candidate = pattern.includes("/")
				? rel
				: (rel.split("/").pop() ?? rel);
			if (!regex.test(candidate)) continue;
			results.push(rel);
			if (results.length >= SEARCH_RESULT_CAP) {
				truncated = true;
				break;
			}
		}
		return {
			ok: true,
			content:
				results.join("\n") +
				(truncated ? `\n[truncated at ${SEARCH_RESULT_CAP} results]` : ""),
		};
	},
};

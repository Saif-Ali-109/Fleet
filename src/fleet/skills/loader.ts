import { readdirSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Role } from "../../types.ts";

export interface SkillSummary {
	name: string;
	description: string;
}

export type SkillLoadResult =
	| { ok: true; body: string }
	| { ok: false; error: string };

const SKILLS_ROOT = fileURLToPath(new URL("./", import.meta.url));

function decodeSafe(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function parseFrontmatter(
	raw: string,
): { meta: Record<string, string>; body: string } | null {
	if (!raw.startsWith("---\n")) return null;
	const close = raw.indexOf("\n---\n", 4);
	if (close < 0) return null;
	const meta: Record<string, string> = {};
	for (const line of raw.slice(4, close).split("\n")) {
		const m = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
		if (m?.[1] && m[2] !== undefined) meta[m[1]] = m[2].trim();
	}
	return { meta, body: raw.slice(close + "\n---\n".length) };
}

function isSafeSkillName(name: string): boolean {
	if (name.length === 0 || name.length > 128) return false;
	const candidates = new Set([name, decodeSafe(name)]);
	for (const candidate of candidates) {
		if (/[/\\]/.test(candidate)) return false;
		if (candidate.includes("..")) return false;
		if (candidate.includes("\0")) return false;
		if (/^[A-Za-z]:/.test(candidate)) return false;
	}
	return true;
}

function containedPath(role: Role, name: string): string {
	const dir = resolve(SKILLS_ROOT, role);
	const file = resolve(dir, `${decodeSafe(name)}.md`);
	if (!file.startsWith(dir + sep)) {
		throw new Error(`skill path escapes role dir: ${JSON.stringify(name)}`);
	}
	return file;
}

export function loadSkillSummaries(role: Role): SkillSummary[] {
	let entries: string[];
	try {
		entries = readdirSync(resolve(SKILLS_ROOT, role));
	} catch {
		return [];
	}
	const summaries: SkillSummary[] = [];
	for (const entry of entries.sort()) {
		if (!entry.endsWith(".md")) continue;
		let raw: string;
		try {
			raw = readFileSync(resolve(SKILLS_ROOT, role, entry), "utf8");
		} catch {
			continue;
		}
		const parsed = parseFrontmatter(raw);
		if (!parsed) continue;
		const name = parsed.meta.name;
		const description = parsed.meta.description;
		if (!name || !description) continue;
		summaries.push({ name, description });
	}
	return summaries;
}

export function formatSkillBlock(summaries: readonly SkillSummary[]): string {
	return [
		"# Available skills",
		...summaries.map((s) => `- ${s.name}: ${s.description}`),
	].join("\n");
}

export function injectSkillSummaries(
	systemPrompt: string,
	summaries: readonly SkillSummary[],
): string {
	if (summaries.length === 0) return systemPrompt;
	return `${systemPrompt}\n${formatSkillBlock(summaries)}\n`;
}

export function injectSkills(systemPrompt: string, role: Role): string {
	return injectSkillSummaries(systemPrompt, loadSkillSummaries(role));
}

export function loadSkill(role: Role, name: string): SkillLoadResult {
	if (!isSafeSkillName(name)) {
		return { ok: false, error: `rejected skill name: ${JSON.stringify(name)}` };
	}
	let file: string;
	try {
		file = containedPath(role, name);
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return { ok: false, error: `skill not found: ${role}/${name}` };
	}
	const parsed = parseFrontmatter(raw);
	const body = parsed ? parsed.body : raw;
	if (!body.trim()) {
		return { ok: false, error: `empty skill body: ${role}/${name}` };
	}
	return { ok: true, body };
}

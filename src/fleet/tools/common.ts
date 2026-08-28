import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { Role } from "../../types.ts";

export interface ToolSchemaProperty {
	type: "string" | "number" | "boolean";
	description?: string;
}

export interface ToolSchema {
	type: "object";
	properties: Record<string, ToolSchemaProperty>;
	required: string[];
	additionalProperties: false;
}

export interface WtCtx {
	worktreeDir: string;
	role: Role;
	runDir?: string;
}

export type ToolResult =
	| { ok: true; content: string; exitCode?: number }
	| { ok: false; error: string };

export interface ToolImpl {
	schema: ToolSchema;
	exec(input: unknown, ctx: WtCtx): Promise<ToolResult>;
}

export class ToolInputError extends Error {}

export function asRecord(input: unknown): Record<string, unknown> {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		throw new ToolInputError("tool input must be an object");
	}
	return input as Record<string, unknown>;
}

export function asString(input: Record<string, unknown>, key: string): string {
	const value = input[key];
	if (typeof value !== "string") {
		throw new ToolInputError(`tool input "${key}" must be a string`);
	}
	return value;
}

export function asOptionalNumber(
	input: Record<string, unknown>,
	key: string,
): number | undefined {
	const value = input[key];
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new ToolInputError(`tool input "${key}" must be a number`);
	}
	return value;
}

export function resolveInside(worktreeDir: string, target: string): string {
	const root = resolve(worktreeDir);
	const full = resolve(root, target);
	if (full !== root && !full.startsWith(root + sep)) {
		throw new Error(`path escapes worktree: ${JSON.stringify(target)}`);
	}
	return full;
}

export function resolveExistingInside(
	worktreeDir: string,
	target: string,
): string {
	const candidate = resolveInside(worktreeDir, target);
	let real: string;
	try {
		real = realpathSync(candidate);
	} catch {
		throw new Error(`no such file: ${target}`);
	}
	const root = realpathSync(resolve(worktreeDir));
	if (real !== root && !real.startsWith(root + sep)) {
		throw new Error(
			`path escapes worktree via symlink: ${JSON.stringify(target)}`,
		);
	}
	return real;
}

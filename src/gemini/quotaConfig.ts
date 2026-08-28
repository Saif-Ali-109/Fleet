import { modelDefaults } from "../fleet/modelDefaults.ts";
import { policyFor } from "../models/modelPolicy.ts";
import type { Role } from "../types.ts";

export interface GeminiQuotaLimit {
	rpm: number;
	tpm: number;
	rpd: number;
}

export type GeminiQuotaLimits = Record<string, GeminiQuotaLimit>;

export const GEMINI_QUOTA_DEFAULTS: Readonly<GeminiQuotaLimits> = Object.freeze(
	{
		"gemini-2.5-pro": { rpm: 5, tpm: 250_000, rpd: 100 },
		"gemini-2.5-flash": { rpm: 10, tpm: 250_000, rpd: 250 },
		"gemini-3-flash-preview": { rpm: 5, tpm: 250_000, rpd: 20 },
		"gemini-3.5-flash": { rpm: 5, tpm: 250_000, rpd: 20 },
		"gemini-2.5-flash-lite": { rpm: 15, tpm: 250_000, rpd: 1_000 },
		"gemini-3.5-flash-lite": { rpm: 15, tpm: 250_000, rpd: 500 },
		"gemini-3.1-flash-lite": { rpm: 15, tpm: 250_000, rpd: 500 },
	},
);

function validLimit(value: unknown): value is GeminiQuotaLimit {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return ["rpm", "tpm", "rpd"].every(
		(key) =>
			typeof v[key] === "number" && Number.isInteger(v[key]) && v[key] > 0,
	);
}

export function parseGeminiQuotaLimits(
	raw: string | undefined,
): GeminiQuotaLimits {
	if (!raw?.trim()) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("Invalid GEMINI_QUOTA_LIMITS JSON");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error("GEMINI_QUOTA_LIMITS must be an object");
	const result: GeminiQuotaLimits = {};
	for (const [model, limit] of Object.entries(parsed)) {
		if (!model.trim() || !validLimit(limit))
			throw new Error(`Invalid Gemini quota limit for model ${model}`);
		result[model] = { ...limit };
	}
	return result;
}

export function geminiQuotaConfig(
	overrides?: GeminiQuotaLimits,
): GeminiQuotaLimits {
	const env = parseGeminiQuotaLimits(
		process.env.GEMINI_QUOTA_LIMITS ?? process.env.GEMINI_QUOTA_OVERRIDES,
	);
	return { ...GEMINI_QUOTA_DEFAULTS, ...env, ...overrides };
}

export function geminiRateLimitWaitMs(
	raw = process.env.GEMINI_RATE_LIMIT_WAIT_MS,
): number {
	if (raw === undefined || raw.trim() === "") return 120_000;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 0)
		throw new Error("GEMINI_RATE_LIMIT_WAIT_MS must be a non-negative integer");
	return value;
}

export function parseGeminiRateLimitModels(raw?: string): string[] {
	const source = raw ?? process.env.GEMINI_RATE_LIMIT_MODELS;
	const seen = new Set<string>();
	for (const segment of (source ?? "").split(",")) {
		const id = segment.trim();
		if (id) seen.add(id);
	}
	return [...seen];
}

export function geminiModelChain(
	_role: Role,
	primary: string,
): { model: string; fallbacks: string[] } {
	return {
		model: primary,
		fallbacks: parseGeminiRateLimitModels().filter(
			(model) => model !== primary,
		),
	};
}

export function warnIfGeminiPoolUnset(
	logger: (msg: string) => void = console.warn,
): void {
	if (parseGeminiRateLimitModels().length === 0) {
		logger(
			"[quota] GEMINI_RATE_LIMIT_MODELS unset — every role runs a single-model chain (no fallback on limits)",
		);
	}
}

export interface GeminiQuotaValidationError {
	role: Role;
	model: string;
	message: string;
}

export function validateGeminiQuotaConfiguration(
	roles: readonly Role[] = [
		"analyzer",
		"planner",
		"coder",
		"tester",
		"reviewer",
		"pr",
	],
	limits: GeminiQuotaLimits = geminiQuotaConfig(),
): GeminiQuotaValidationError[] {
	const errors: GeminiQuotaValidationError[] = [];
	for (const role of roles) {
		const policy = policyFor(role, "gemini");
		for (const model of new Set([policy.model, ...policy.fallbacks])) {
			const limit = limits[model];
			if (!model.trim())
				errors.push({ role, model, message: "model id is empty" });
			else if (!limit)
				errors.push({ role, model, message: "missing quota limits" });
			else if (!validLimit(limit))
				errors.push({
					role,
					model,
					message: "quota limits must be positive integers",
				});
		}
	}
	return errors;
}

export function assertGeminiQuotaConfiguration(
	roles?: readonly Role[],
	limits: GeminiQuotaLimits = geminiQuotaConfig(),
): void {
	const errors = validateGeminiQuotaConfiguration(roles, limits);
	if (errors.length)
		throw new Error(
			`Invalid Gemini quota configuration:\n${errors.map((e) => `${e.role}/${e.model}: ${e.message}`).join("\n")}`,
		);
}

export function validateGeminiModelChainConfiguration(
	roles: readonly Role[] = [
		"analyzer",
		"planner",
		"coder",
		"tester",
		"reviewer",
		"pr",
	],
	limits: GeminiQuotaLimits = geminiQuotaConfig(),
): GeminiQuotaValidationError[] {
	const errors: GeminiQuotaValidationError[] = [];
	for (const role of roles) {
		const envVar = `${role.toUpperCase()}_MODEL_GEMINI`;
		const raw = process.env[envVar];
		const primary = typeof raw === "string" ? raw.trim() : "";
		if (!primary) {
			errors.push({ role, model: "", message: `missing ${envVar}` });
			continue;
		}
		const chain = geminiModelChain(role, primary);
		for (const model of new Set([chain.model, ...chain.fallbacks])) {
			const limit = limits[model];
			if (!limit) errors.push({ role, model, message: "missing quota limits" });
			else if (!validLimit(limit))
				errors.push({
					role,
					model,
					message: "quota limits must be positive integers",
				});
		}
	}
	return errors;
}

export function assertGeminiModelChainConfiguration(
	roles?: readonly Role[],
	limits: GeminiQuotaLimits = geminiQuotaConfig(),
): void {
	const errors = validateGeminiModelChainConfiguration(roles, limits);
	if (errors.length)
		throw new Error(
			`Invalid Gemini model chain configuration:\n${errors.map((e) => `${e.role}/${e.model}: ${e.message}`).join("\n")}`,
		);
}

export function configuredGeminiModels(): string[] {
	return [...new Set(Object.values(modelDefaults.gemini))];
}

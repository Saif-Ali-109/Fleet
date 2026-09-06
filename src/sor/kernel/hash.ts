// SoR Kernel — canonical representation and self-hash (FR-2, §7.4).

import { createHash } from "node:crypto";
import { canonicalJson } from "../signer.ts";
import type { SorRecordIdentity, SorType } from "./types.ts";

export function sha256Hex(input: string): string {
	return createHash("sha256").update(input).digest("hex");
}

/** §7.4 content rules: BOM strip, NFC, \r\n/\r→\n, trim line and corpus edges. */
export function canonicalizeText(text: string): string {
	let out = text.replace(/^\uFEFF/, "");
	out = out.normalize("NFC");
	out = out.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	out = out
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n");
	return out.trim();
}

/** §7.4 policy/context rule: delegate to the audit signer's canonical JSON (single discipline). */
export function canonicalizeStructured(body: unknown): string {
	return canonicalJson(body);
}

export function canonicalRepresentation(input: {
	sorType: SorType;
	body: unknown;
}): string {
	switch (input.sorType) {
		case "content":
			return canonicalizeText(String(input.body));
		case "policy":
		case "context":
			return canonicalizeStructured(input.body);
	}
}

export function computeCanonicalHash(input: {
	sorType: SorType;
	body: unknown;
}): string {
	return sha256Hex(canonicalRepresentation(input));
}

export function verifyCanonicalHash(
	record: SorRecordIdentity,
	body: unknown,
): boolean {
	return (
		record.hash === computeCanonicalHash({ sorType: record.sorType, body })
	);
}

export function assertCanonicalHash(
	record: SorRecordIdentity,
	body: unknown,
): void {
	if (!verifyCanonicalHash(record, body)) {
		throw new Error(
			`SoR hash mismatch for ${record.sorType}:${record.sourceId} v${record.version}; expected ${record.hash}, got ${computeCanonicalHash(
				{
					sorType: record.sorType,
					body,
				},
			)}`,
		);
	}
}

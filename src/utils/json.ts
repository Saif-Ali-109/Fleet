/**
 * Robust JSON extraction with length guards and sanity checks.
 * Strips optional ```json fences and parses the first balanced {...} object in `text`.
 * Includes protections against excessive salvage attempts and empty object acceptance.
 */
export function extractJson<T>(text: string): T | null {
	// Strip optional ```json fences
	const cleaned = text.replace(/```(?:json)?/gi, "");
	const start = cleaned.indexOf("{");
	if (start === -1) return null;

	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < cleaned.length; i++) {
		const ch = cleaned[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") depth += 1;
		else if (ch === "}") {
			depth -= 1;
			if (depth === 0) {
				try {
					const result = JSON.parse(cleaned.slice(start, i + 1)) as T;
					// Sanity check: reject empty object as salvage artifact
					if (
						typeof result === "object" &&
						result !== null &&
						!Array.isArray(result) &&
						Object.keys(result).length === 0
					) {
						return null;
					}
					return result;
				} catch {
					return null;
				}
			}
		}
	}

	// Some providers cap output tokens, so responses can be truncated mid-JSON.
	// Salvage the unclosed object by appending closing quote/brace/array tails until it parses.
	const base = cleaned.slice(start);

	// Length guard: skip salvage if raw slice > 100KB
	if (base.length > 100 * 1024) {
		return null;
	}

	const maxK = Math.min(depth, 25);
	for (let k = 1; k <= maxK; k++) {
		const closes = "}".repeat(k);
		for (const tail of [`"${closes}`, closes, `]${closes}`, `"]${closes}`]) {
			try {
				const parsed = JSON.parse(base + tail);
				// Sanity check: reject empty object as salvage artifact
				if (
					typeof parsed === "object" &&
					parsed !== null &&
					!Array.isArray(parsed) &&
					Object.keys(parsed).length === 0
				) {
					return null;
				}
				// Log warning when salvage succeeds
				console.warn("[json] Salvaged truncated JSON via extractJson");
				return parsed as T;
			} catch {
				// try the next candidate tail
			}
		}
	}
	return null;
}

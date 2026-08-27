// Wire protocol for Gemini quota-driven model switching between workers and
// the Manager. Workers throw these sentinel errors; agentRunner parses them
// to walk the configured model chain (PLAN.md "Rate-limit fallback system").
//
// Semantics agreed with owner:
// - ANY reservation block (rpm/tpm/rpd) switches models immediately.
// - rpd terminal exhaustion keeps its legacy sentinel (RPD_QUOTA_EXHAUSTED).
// - Finite blocks (rpm/tpm, incl. single-request TPM overflow) surface as
//   GEMINI_RATE_LIMIT_SWITCH:<block>:<waitMs> where waitMs >= 0 is when the
//   SAME model would free up; 0 means it can never fit this request.

export const RATE_LIMIT_SWITCH_PREFIX = "GEMINI_RATE_LIMIT_SWITCH:";
export const RPD_EXHAUSTED = "RPD_QUOTA_EXHAUSTED";
export const ALL_RPD_EXHAUSTED = "ALL_GEMINI_MODELS_RPD_EXHAUSTED";

export type RateLimitBlock = "rpm" | "tpm";

export interface RateLimitSwitchSignal {
  block: RateLimitBlock;
  waitMs: number;
}

export function rateLimitSwitchError(block: RateLimitBlock, waitMs: number): Error {
  return new Error(`${RATE_LIMIT_SWITCH_PREFIX}${block}:${Math.max(0, Math.floor(waitMs))}`);
}

export function parseRateLimitSwitch(errorMsg: string | undefined): RateLimitSwitchSignal | undefined {
  if (!errorMsg?.startsWith(RATE_LIMIT_SWITCH_PREFIX)) return undefined;
  const rest = errorMsg.slice(RATE_LIMIT_SWITCH_PREFIX.length);
  const sep = rest.lastIndexOf(":");
  if (sep <= 0) return undefined;
  const block = rest.slice(0, sep);
  if (block !== "rpm" && block !== "tpm") return undefined;
  const waitMs = Number(rest.slice(sep + 1));
  if (!Number.isFinite(waitMs) || waitMs < 0) return undefined;
  return { block, waitMs };
}

import type { GeminiQuotaLimit, GeminiQuotaLimits } from "./quotaConfig.ts";

export type QuotaBlock = "rpm" | "tpm" | "rpd" | "error";
export interface ReservationRequest { provider: "gemini"; model: string; estimatedInputTokens: number; maximumOutputTokens: number; now?: number; }
export interface ReservationResult {
  ok: boolean;
  reservationId?: string;
  waitMs?: number;
  block?: QuotaBlock;
  terminal?: boolean;
  resetAt?: number;
  error?: string;
}

interface Reservation { id: string; at: number; tokens: number; }
interface ModelState { requests: Reservation[]; daily: Reservation[]; exhaustedUntil?: number; }

const WINDOW = 60_000;
const DAY = 86_400_000;

export class GeminiQuotaCoordinator {
  private readonly state = new Map<string, ModelState>();
  private readonly limits: GeminiQuotaLimits;
  private sequence = 0;
  private failed = false;

  constructor(limits: GeminiQuotaLimits, private readonly clock: () => number = Date.now) {
    this.limits = Object.fromEntries(Object.entries(limits).map(([model, limit]) => [model, { ...limit }]));
    for (const [model, limit] of Object.entries(this.limits)) {
      if (!model.trim() || !validLimit(limit)) throw new Error(`Invalid Gemini quota limit for model ${model}`);
      this.state.set(model, { requests: [], daily: [] });
    }

  }

  reserve(request: ReservationRequest): ReservationResult {
    if (this.failed) return { ok: false, block: "error", error: "Gemini quota coordinator is unavailable" };
    try {
      const limit = this.limits[request.model];
      if (request.provider !== "gemini" || !limit || !Number.isInteger(request.estimatedInputTokens) ||
          !Number.isInteger(request.maximumOutputTokens) || request.estimatedInputTokens < 0 || request.maximumOutputTokens < 0) {
        return this.trip("Invalid reservation request");
      }
      const now = request.now ?? this.clock();
      const state = this.state.get(request.model)!;
      this.prune(state, now);
      if (state.exhaustedUntil !== undefined) {
        if (now >= state.exhaustedUntil) state.exhaustedUntil = undefined;
        else return { ok: false, block: "rpd", terminal: true, resetAt: state.exhaustedUntil };
      }
      const tokens = request.estimatedInputTokens + request.maximumOutputTokens;
      if (tokens > limit.tpm) return { ok: false, block: "tpm", waitMs: 0, error: "Reservation exceeds model TPM limit" };
      if (state.daily.length >= limit.rpd) {
        const resetAt = nextUtcMidnight(now);
        state.exhaustedUntil = resetAt;
        return { ok: false, block: "rpd", terminal: true, resetAt };
      }
      const rpmWait = state.requests.length >= limit.rpm ? (state.requests[0]!.at + WINDOW - now) : 0;
      const usedTokens = state.requests.reduce((sum, r) => sum + r.tokens, 0);
      const tpmWait = usedTokens + tokens > limit.tpm && state.requests.length ? (state.requests[0]!.at + WINDOW - now) : 0;
      if (rpmWait > 0 || tpmWait > 0) return { ok: false, block: rpmWait >= tpmWait ? "rpm" : "tpm", waitMs: Math.max(rpmWait, tpmWait) };
      const reservation = { id: `${request.model}:${++this.sequence}`, at: now, tokens };
      state.requests.push(reservation);
      state.daily.push(reservation);
      return { ok: true, reservationId: reservation.id };
    } catch {
      this.failed = true;
      return { ok: false, block: "error", error: "Gemini quota coordinator is unavailable" };
    }
  }

  checkAndReserve(request: ReservationRequest): ReservationResult {
    return this.reserve(request);
  }

  /** Clear every ModelState bucket (requests/daily/exhaustedUntil) and the failed latch (SPEC §11.5 key-change resume). */
  resetAll(): void {
    for (const state of this.state.values()) {
      state.requests = [];
      state.daily = [];
      state.exhaustedUntil = undefined;
    }
    this.failed = false;
  }

  recordUsage(_reservationId: string, _actualInputTokens: number, _actualOutputTokens: number): void {
    if (this.failed) throw new Error("Gemini quota coordinator is unavailable");
  }

  modelState(model: string, now = this.clock()): { quotaExhausted: boolean; resetAt?: number } {
    const s = this.state.get(model);
    if (!s) throw new Error("Unknown Gemini model");
    if (s.exhaustedUntil !== undefined && now >= s.exhaustedUntil) s.exhaustedUntil = undefined;
    return { quotaExhausted: s.exhaustedUntil !== undefined, resetAt: s.exhaustedUntil };
  }

  private prune(state: ModelState, now: number): void {
    state.requests = state.requests.filter((r) => r.at + WINDOW > now);
    const dayStart = utcDayStart(now);
    state.daily = state.daily.filter((r) => r.at >= dayStart);
  }
  private trip(error: string): ReservationResult {
    this.failed = true;
    return { ok: false, block: "error", error };
  }
}

function validLimit(limit: GeminiQuotaLimit): boolean {
  return Number.isInteger(limit.rpm) && limit.rpm > 0 && Number.isInteger(limit.tpm) && limit.tpm > 0 && Number.isInteger(limit.rpd) && limit.rpd > 0;
}
function utcDayStart(ms: number): number { const d = new Date(ms); d.setUTCHours(0, 0, 0, 0); return d.getTime(); }
function nextUtcMidnight(ms: number): number { return utcDayStart(ms) + DAY; }

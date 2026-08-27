// Manager-side Gemini quota notification bus (PLAN.md "Rate-limit fallback
// system"). Workers emit raw model_switch telemetry into traces for diagnosis;
// these events are the user-facing counterpart, consumed by orchestrator /
// dashboard / TUI subscribers. Emission never throws: a bad subscriber must
// not break a run.

import type { Role } from "../types.ts";

export interface QuotaModelSwitchEvent {
  type: "model_switch";
  role: Role;
  provider: "gemini";
  fromModel: string;
  toModel: string;
  block: string;
  waitMs: number;
}

export interface QuotaModelRecoveredEvent {
  type: "model_recovered";
  role: Role;
  provider: "gemini";
  model: string;
}

export interface QuotaAllExhaustedEvent {
  type: "all_models_exhausted";
  role: Role;
  provider: "gemini";
  models: string[];
}

export type QuotaEvent = QuotaModelSwitchEvent | QuotaModelRecoveredEvent | QuotaAllExhaustedEvent;

type QuotaEventListener = (event: QuotaEvent) => void;

const listeners = new Set<QuotaEventListener>();

/** Subscribe to quota events; returns an unsubscribe function. */
export function onQuotaEvent(cb: QuotaEventListener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Fan an event out to every subscriber; listener throws are swallowed. */
export function emitQuotaEvent(event: QuotaEvent): void {
  for (const cb of [...listeners]) {
    try {
      cb(event);
    } catch {
      // a broken subscriber must never abort a run
    }
  }
}

/** Drop every listener (test isolation). */
export function resetQuotaEventListeners(): void {
  listeners.clear();
}

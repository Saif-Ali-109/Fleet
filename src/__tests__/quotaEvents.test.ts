import { describe, it, expect, afterEach } from "vitest";
import {
  emitQuotaEvent,
  onQuotaEvent,
  resetQuotaEventListeners,
  type QuotaAllExhaustedEvent,
  type QuotaModelRecoveredEvent,
  type QuotaModelSwitchEvent,
} from "../fleet/quotaEvents.ts";

const switchEvent: QuotaModelSwitchEvent = {
  type: "model_switch",
  role: "coder",
  provider: "gemini",
  fromModel: "gemini-a",
  toModel: "gemini-b",
  block: "rpm",
  waitMs: 4200,
};

const recoveredEvent: QuotaModelRecoveredEvent = {
  type: "model_recovered",
  role: "analyzer",
  provider: "gemini",
  model: "gemini-a",
};

const exhaustedEvent: QuotaAllExhaustedEvent = {
  type: "all_models_exhausted",
  role: "tester",
  provider: "gemini",
  models: ["gemini-a", "gemini-b"],
};

describe("quotaEvents", () => {
  afterEach(() => {
    resetQuotaEventListeners();
  });

  it("delivers emitted events to every subscriber", () => {
    const seenA: string[] = [];
    const seenB: string[] = [];
    onQuotaEvent((e) => seenA.push(e.type));
    onQuotaEvent((e) => seenB.push(e.type));

    emitQuotaEvent(switchEvent);
    emitQuotaEvent(recoveredEvent);
    emitQuotaEvent(exhaustedEvent);

    expect(seenA).toEqual(["model_switch", "model_recovered", "all_models_exhausted"]);
    expect(seenB).toEqual(["model_switch", "model_recovered", "all_models_exhausted"]);
  });

  it("returns an unsubscribe function that detaches the listener", () => {
    const seen: string[] = [];
    const unsub = onQuotaEvent((e) => seen.push(e.type));

    emitQuotaEvent(switchEvent);
    unsub();
    emitQuotaEvent(recoveredEvent);

    expect(seen).toEqual(["model_switch"]);
  });

  it("never subscribes the same listener twice", () => {
    const seen: number[] = [];
    const cb = (): void => {
      seen.push(1);
    };
    onQuotaEvent(cb);
    onQuotaEvent(cb);

    emitQuotaEvent(recoveredEvent);

    expect(seen).toEqual([1]);
  });

  it("swallows a throwing subscriber so a bad listener cannot break a run", () => {
    const seen: string[] = [];
    onQuotaEvent(() => {
      throw new Error("bad subscriber");
    });
    onQuotaEvent((e) => seen.push(e.type));

    expect(() => emitQuotaEvent(switchEvent)).not.toThrow();
    expect(seen).toEqual(["model_switch"]);
  });

  it("supports unsubscribing from inside a listener without breaking the fan-out", () => {
    const seen: string[] = [];
    const unsub = onQuotaEvent((e) => {
      seen.push(e.type);
      unsub();
    });
    onQuotaEvent((e) => seen.push(`after:${e.type}`));

    emitQuotaEvent(recoveredEvent);
    emitQuotaEvent(exhaustedEvent);

    expect(seen).toEqual(["model_recovered", "after:model_recovered", "after:all_models_exhausted"]);
  });

  it("resetQuotaEventListeners drops every listener", () => {
    const seen: string[] = [];
    onQuotaEvent((e) => seen.push(e.type));
    onQuotaEvent((e) => seen.push(e.type));

    resetQuotaEventListeners();
    emitQuotaEvent(switchEvent);

    expect(seen).toEqual([]);
  });
});

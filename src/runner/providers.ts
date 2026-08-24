import type { ProviderName } from "../types.ts";

export interface ProviderTrace {
  text: string;
  sessionID: string | null;
  model?: string | null;
  tokens: { input: number; output: number; reasoning: number; cached: number; cacheWrite: number; total: number };
  costUsd: number;
  sawError: boolean;
  errorMsg?: string;
}

/** Parse a trace body into a normalized shape for the new NDJSON format. */
export function parseProviderTrace(
  provider: ProviderName,
  rawBody: string,
  startOffset: number,
  opts: { lastmsgPath?: string } = {},
): ProviderTrace {
  const body = startOffset > 0 ? rawBody.slice(startOffset) : rawBody;
  const acc: ProviderTrace = emptyProviderTrace();

  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue; // non-JSON noise that leaked into the trace
    }
    parseProviderLine(provider, ev, acc);
  }

  return acc;
}

/** Dispatch one trace line to the provider's line parser (SPEC §6 wire schema, keyed on `t`). */
export function parseProviderLine(provider: ProviderName, ev: any, acc: ProviderTrace): void {
  switch (ev.t) {
    case "init":
      if (typeof ev.sessionId === "string" && ev.sessionId && !acc.sessionID) acc.sessionID = ev.sessionId;
      if (typeof ev.model === "string" && ev.model && !acc.model) acc.model = ev.model;
      break;
    case "text":
      if (typeof ev.part?.text === "string" && ev.part.text) {
        acc.text += ev.part.text;
      }
      break;
    case "tool_call":
      // Tool calls don't add to text output directly
      break;
    case "tool_result":
      // Tool results don't add to text output directly
      break;
    case "step_finish":
      if (ev.usage) {
        acc.tokens.input += ev.usage.input ?? 0;
        acc.tokens.output += ev.usage.output ?? 0;
        acc.tokens.reasoning += ev.usage.reasoning ?? 0;
        acc.tokens.cached += ev.usage.cached ?? 0;
        acc.tokens.cacheWrite += ev.usage.cacheWrite ?? 0;
        acc.tokens.total = acc.tokens.input + acc.tokens.output + acc.tokens.reasoning + acc.tokens.cached;
      }
      acc.costUsd += ev.costUsd ?? 0;
      break;
    case "error":
      acc.sawError = true;
      acc.errorMsg =
        ev.error == null ? "Unknown error"
        : typeof ev.error === "string" ? ev.error
        : JSON.stringify(ev.error);
      break;
    case "result":
      // Final result - text already accumulated via "text" events
      break;
    default:
      // Ignore unknown event types
      break;
  }
}

const emptyProviderTrace = (): ProviderTrace => ({
  text: "",
  sessionID: null,
  model: null,
  tokens: { input: 0, output: 0, reasoning: 0, cached: 0, cacheWrite: 0, total: 0 },
  costUsd: 0,
  sawError: false,
});

import type { ProviderName } from "../types.ts";

export interface ProviderTrace {
  text: string;
  sessionID: string | null;
  model?: string | null;
  tokens: { input: number; output: number; reasoning: number; cached: number; cacheWrite: number; total: number };
  costUsd: number;
  sawError: boolean;
  errorMsg?: string;
  /** Exit code of the most recent `bash` tool_result in the trace, if any (SPEC: used by the
   *  tester to gate pass/fail on the real test command's exit code instead of on LLM self-report).
   *  NOTE: this is "whatever bash call ran last" — it is NOT necessarily the test command itself
   *  (a worker may run further bash calls, e.g. `git commit`, after the test command). Callers
   *  that need "did *this specific command* pass" should use `bashCommands` instead. */
  lastBashExitCode?: number;
  /** Every `bash` tool call observed in the trace, in order, paired with its exit code (if the
   *  matching tool_result carried one). Lets callers find the outcome of a *specific* command —
   *  e.g. the tester workflow matching against the actual test command — instead of assuming
   *  the last bash call in the trace is the one they care about. */
  bashCommands: Array<{ command: string; exitCode?: number }>;
  tools: number;
  models: number;
  skills: number;
  breakdown: Record<string, number>;
}

/** Internal parse accumulator: ProviderTrace plus bookkeeping not exposed to callers. */
interface ProviderTraceAcc extends ProviderTrace {
  /** Command string from the most recent unmatched `bash` tool_call, awaiting its tool_result. */
  _pendingBashCommand?: string;
}

/** Parse a trace body into a normalized shape for the new NDJSON format. */
export function parseProviderTrace(
  provider: ProviderName,
  rawBody: string,
  startOffset: number,
  opts: { lastmsgPath?: string } = {},
): ProviderTrace {
  const body = startOffset > 0 ? rawBody.slice(startOffset) : rawBody;
  const acc: ProviderTraceAcc = emptyProviderTrace();

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

  const { _pendingBashCommand, ...trace } = acc;
  return trace;
}

/** Dispatch one trace line to the provider's line parser (SPEC §6 wire schema, keyed on `t`). */
export function parseProviderLine(provider: ProviderName, ev: any, acc: ProviderTraceAcc): void {
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
    case "tool_call": {
      // Stash the command string so the matching tool_result below can pair
      // it with an exit code — tool_result events don't carry the command.
      if (ev.name === "bash" && typeof ev.input?.command === "string") {
        acc._pendingBashCommand = ev.input.command;
      }
      const toolName = ev.name as string;
      acc.tools++;
      acc.breakdown[toolName] = (acc.breakdown[toolName] ?? 0) + 1;
      if (toolName === "load_skill") acc.skills++;
      break;
    }
    case "tool_result":
      // Tool results don't add to text output directly, but track the most
      // recent bash exit code so callers (e.g. the tester workflow) can gate
      // pass/fail on the actual command result instead of on LLM self-report.
      if (ev.name === "bash" && typeof ev.exitCode === "number") {
        acc.lastBashExitCode = ev.exitCode;
        acc.bashCommands.push({ command: acc._pendingBashCommand ?? "", exitCode: ev.exitCode });
      }
      acc._pendingBashCommand = undefined;
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
    case "telemetry": {
      const evt = ev.event as string | undefined;
      const status = ev.status as string | undefined;
      if (evt === "provider_completion" && status === "completed") {
        acc.models++;
      }
      break;
    }
    default:
      // Ignore unknown event types
      break;
  }
}

const emptyProviderTrace = (): ProviderTraceAcc => ({
  text: "",
  sessionID: null,
  model: null,
  tokens: { input: 0, output: 0, reasoning: 0, cached: 0, cacheWrite: 0, total: 0 },
  costUsd: 0,
  sawError: false,
  bashCommands: [],
  tools: 0,
  models: 0,
  skills: 0,
  breakdown: {},
});

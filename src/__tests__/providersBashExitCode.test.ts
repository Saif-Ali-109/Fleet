import { describe, expect, it } from "vitest";
import { parseProviderTrace } from "../runner/providers.ts";

// Regression coverage for the "tester reports pass even when the test command
// failed" bug: the tester used to gate on `res.ok && res.text.length > 0 &&
// !res.sawError`, which only checks that the LLM ran without an infra error
// and wrote *some* text — never the actual test command's exit code. These
// tests lock in that `parseProviderTrace` now surfaces the real exit code of
// the most recent `bash` tool_result so the tester can gate on that instead.
function line(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

describe("parseProviderTrace lastBashExitCode", () => {
  it("is undefined when no bash tool_result appears in the trace", () => {
    const raw = line({ t: "text", part: { text: "hello" } });
    const trace = parseProviderTrace("gemini", raw, 0);
    expect(trace.lastBashExitCode).toBeUndefined();
  });

  it("captures exit code 0 from a passing bash tool_result", () => {
    const raw =
      line({ t: "tool_call", name: "bash", input: { command: "npm test" } }) +
      line({ t: "tool_result", name: "bash", ok: true, ms: 120, bytesOut: 40, exitCode: 0 });
    const trace = parseProviderTrace("gemini", raw, 0);
    expect(trace.lastBashExitCode).toBe(0);
  });

  it("captures a non-zero exit code from a failing bash tool_result", () => {
    const raw = line({ t: "tool_result", name: "bash", ok: true, ms: 80, bytesOut: 10, exitCode: 1 });
    const trace = parseProviderTrace("gemini", raw, 0);
    expect(trace.lastBashExitCode).toBe(1);
  });

  it("uses the MOST RECENT bash exit code when multiple bash calls occur", () => {
    const raw =
      line({ t: "tool_result", name: "bash", ok: true, ms: 10, bytesOut: 5, exitCode: 1 }) +
      line({ t: "tool_result", name: "bash", ok: true, ms: 10, bytesOut: 5, exitCode: 0 });
    const trace = parseProviderTrace("gemini", raw, 0);
    expect(trace.lastBashExitCode).toBe(0);
  });

  it("ignores tool_result events from non-bash tools", () => {
    const raw = line({ t: "tool_result", name: "read_file", ok: true, ms: 5, bytesOut: 20 });
    const trace = parseProviderTrace("gemini", raw, 0);
    expect(trace.lastBashExitCode).toBeUndefined();
  });

  it("captures bashCommands paired with each command's own exit code, in order", () => {
    const raw =
      line({ t: "tool_call", name: "bash", input: { command: "npm test" } }) +
      line({ t: "tool_result", name: "bash", ok: true, ms: 500, bytesOut: 100, exitCode: 0 }) +
      line({ t: "tool_call", name: "bash", input: { command: "git commit -m test" } }) +
      line({ t: "tool_result", name: "bash", ok: true, ms: 50, bytesOut: 30, exitCode: 1 });
    const trace = parseProviderTrace("gemini", raw, 0);
    // lastBashExitCode still reflects "whatever ran last" (documented, existing behavior)...
    expect(trace.lastBashExitCode).toBe(1);
    // ...but bashCommands lets a caller find the SPECIFIC command's own outcome, which
    // is what the tester workflow now uses instead of trusting the trace's last call.
    expect(trace.bashCommands).toEqual([
      { command: "npm test", exitCode: 0 },
      { command: "git commit -m test", exitCode: 1 },
    ]);
  });

  it("does not leak the internal pending-command bookkeeping field onto the returned trace", () => {
    const raw = line({ t: "tool_call", name: "bash", input: { command: "npm test" } });
    const trace = parseProviderTrace("gemini", raw, 0);
    expect(trace).not.toHaveProperty("_pendingBashCommand");
  });

  it("does NOT report an LLM's descriptive text as a pass when the exit code is missing", () => {
    // Simulates the exact bug scenario: the worker wrote plausible-looking
    // text summarizing "tests passed" but no bash tool_result with an exit
    // code was ever recorded (e.g. it never actually ran the command).
    const raw = line({ t: "text", part: { text: "All tests passed successfully!" } });
    const trace = parseProviderTrace("gemini", raw, 0);
    expect(trace.lastBashExitCode).toBeUndefined();
    expect(trace.text).toContain("passed");
    // The tester's gating logic (see tester.ts) treats an undefined exit code
    // as "fall back to heuristic", not as an automatic pass — this test only
    // documents that the trace itself carries no exit-code evidence here.
  });
});

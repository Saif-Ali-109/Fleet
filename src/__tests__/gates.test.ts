import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { gate, confirm, ask, type GateResult } from "../gates.ts";

// Mocked readline: each `confirm`/`ask` call pops the next preset answer.
// Variables referenced inside vi.mock must be prefixed with `mock`.
const mockReadlineAnswers: string[] = [];
let mockReadlineIndex = 0;
const mockQuestionCalls: string[] = [];
let mockCloseCalls = 0;

vi.mock("node:readline", () => ({
  createInterface: () => ({
    question: (q: string, cb: (ans: string) => void) => {
      mockQuestionCalls.push(q);
      const ans =
        mockReadlineIndex < mockReadlineAnswers.length
          ? (mockReadlineAnswers[mockReadlineIndex] ?? "")
          : "";
      mockReadlineIndex++;
      cb(ans);
    },
    close: () => {
      mockCloseCalls++;
    },
  }),
}));

function resetReadline(answers: string[]) {
  mockReadlineAnswers.length = 0;
  mockReadlineAnswers.push(...answers);
  mockReadlineIndex = 0;
  mockQuestionCalls.length = 0;
  mockCloseCalls = 0;
}

describe("confirm", () => {
  it.each([
    ["y", true],
    ["Y", true],
    ["yes", true],
    ["YES", true],
    ["  yes  ", true],
    ["\tyES\n", true],
    ["n", false],
    ["", false],
    ["no", false],
    ["maybe", false],
    ["yep", false],
    ["yaaa", false],
  ])("parses %p -> %s", async (input, expected) => {
    resetReadline([input]);
    expect(await confirm("Proceed?")).toBe(expected);
  });

  it("prompts with a [y/N] suffix", async () => {
    resetReadline(["y"]);
    await confirm("Proceed?");
    expect(mockQuestionCalls[0]).toMatch(/\[y\/N\]/);
  });

  it("closes the readline interface after answering", async () => {
    resetReadline(["y"]);
    await confirm("Proceed?");
    expect(mockCloseCalls).toBeGreaterThanOrEqual(1);
  });
});

describe("ask", () => {
  it("returns a trimmed answer", async () => {
    resetReadline(["  some text  "]);
    expect(await ask("What?")).toBe("some text");
  });

  it("returns an empty string for a blank answer", async () => {
    resetReadline([""]);
    expect(await ask("What?")).toBe("");
  });

  it("does not append a [y/N] suffix to the prompt", async () => {
    resetReadline(["hello"]);
    await ask("Enter feedback");
    expect(mockQuestionCalls[0]).not.toMatch(/\[y\/N\]/);
  });
});

describe("gate", () => {
  let stdoutWrite: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    stdoutWrite = vi.fn();
    vi.spyOn(process.stdout, "write").mockImplementation(stdoutWrite as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("auto-approves in non-interactive mode without prompting", async () => {
    resetReadline([]);
    const result = await gate("deploy", "Release v1.2.3", { interactive: false });
    const r = result as GateResult;
    expect(r.approved).toBe(true);
    expect(r.feedback).toBeUndefined();
    expect(mockQuestionCalls.length).toBe(0);
    expect(stdoutWrite).toHaveBeenCalledWith(
      expect.stringContaining("auto-approved: non-interactive mode"),
    );
  });

  it("auto-approved result carries no feedback and writes the label + body", async () => {
    resetReadline([]);
    const r = (await gate("deploy", "do the thing", { interactive: false })) as GateResult;
    expect(r.approved).toBe(true);
    expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining("▶ deploy"));
    expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining("do the thing"));
  });

  it("approves interactively on an explicit yes", async () => {
    resetReadline(["y"]);
    const r = (await gate("deploy", "body", { interactive: true })) as GateResult;
    expect(r.approved).toBe(true);
    expect(mockQuestionCalls.length).toBe(1);
  });

  it("rejects on anything but an explicit yes", async () => {
    resetReadline(["n"]);
    const r = (await gate("deploy", "body", {
      interactive: true,
      captureFeedbackOnReject: false,
    })) as GateResult;
    expect(r.approved).toBe(false);
    expect(r.feedback).toBeUndefined();
    expect(mockQuestionCalls.length).toBe(1);
  });

  it("rejects without capturing feedback when captureFeedbackOnReject is false", async () => {
    resetReadline(["n"]);
    const r = (await gate("deploy", "body", {
      interactive: true,
      captureFeedbackOnReject: false,
    })) as GateResult;
    expect(r.approved).toBe(false);
    expect(r.feedback).toBeUndefined();
    expect(mockQuestionCalls.length).toBe(1);
  });

  it("captures feedback on rejection when captureFeedbackOnReject is true", async () => {
    resetReadline(["n", "please add tests"]);
    const r = (await gate("deploy", "body", {
      interactive: true,
      captureFeedbackOnReject: true,
    })) as GateResult;
    expect(r.approved).toBe(false);
    expect(r.feedback).toBe("please add tests");
    expect(mockQuestionCalls.length).toBe(2);
  });

  it("treats blank feedback as undefined", async () => {
    resetReadline(["n", "   "]);
    const r = (await gate("deploy", "body", {
      interactive: true,
      captureFeedbackOnReject: true,
    })) as GateResult;
    expect(r.approved).toBe(false);
    expect(r.feedback).toBeUndefined();
    expect(mockQuestionCalls.length).toBe(2);
  });

  it("defaults to interactive mode when opts omitted", async () => {
    resetReadline(["y"]);
    const r = (await gate("deploy", "body")) as GateResult;
    expect(r.approved).toBe(true);
  });
});

// W2A §1.3 shutdown-controller units + watched-slug normalization.
// index.ts is imported with a pre-set `--help` argv so main() returns
// immediately; FLEET_SKIP_SHUTDOWN_HANDLERS keeps real signal handlers off.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseIssueEvent } from "../daemon/webhook.ts";

process.env.FLEET_SKIP_SHUTDOWN_HANDLERS = "1";
const realArgv = process.argv;
process.argv = [process.argv[0] ?? "node", "index.ts", "--help"];
const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
const { createShutdownController, installShutdownHandlers, normalizeWatchedSlug, SHUTDOWN_EXIT_CODE, createSingleIssueStopHandler } =
  await import("../index.ts");
process.argv = realArgv;

const makeController = (overrides: Partial<Parameters<typeof createShutdownController>[0]> = {}) => {
  const onFirstSignal = vi.fn();
  const forceExit = vi.fn();
  const setExitCode = vi.fn();
  const controller = createShutdownController({
    isRunning: () => true,
    onFirstSignal,
    forceExit,
    setExitCode,
    ...overrides,
  });
  return { controller, onFirstSignal, forceExit, setExitCode };
};

beforeEach(() => {
  consoleSpy.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createShutdownController", () => {
  it("first signal during a run: calls onFirstSignal once and stays alive", () => {
    const { controller, onFirstSignal, forceExit } = makeController();

    controller.handleSignal("SIGINT");

    expect(onFirstSignal).toHaveBeenCalledTimes(1);
    expect(forceExit).not.toHaveBeenCalled();
    expect(controller.isPending()).toBe(true);
    expect(consoleSpy).toHaveBeenCalledWith("[shutdown] signal received — stopping workers and finalizing…");
  });

  it("first signal is graceful exactly once; second signal forces immediate exit 130", () => {
    const { controller, onFirstSignal, forceExit } = makeController();

    controller.handleSignal("SIGINT");
    controller.handleSignal("SIGTERM");

    expect(onFirstSignal).toHaveBeenCalledTimes(1);
    expect(forceExit).toHaveBeenCalledTimes(1);
    expect(forceExit).toHaveBeenCalledWith(SHUTDOWN_EXIT_CODE);
    expect(consoleSpy).toHaveBeenCalledWith("[shutdown] SIGTERM received again — forcing exit.");
  });

  it("signal with no active run exits 130 immediately without touching the run", () => {
    const { controller, onFirstSignal, forceExit } = makeController({ isRunning: () => false });

    controller.handleSignal("SIGINT");

    expect(onFirstSignal).not.toHaveBeenCalled();
    expect(forceExit).toHaveBeenCalledTimes(1);
    expect(forceExit).toHaveBeenCalledWith(SHUTDOWN_EXIT_CODE);
    expect(controller.isPending()).toBe(false);
  });

  it("concludeAfterFinalize pins exit code 130 and force-exits via the 10s safety timer", () => {
    vi.useFakeTimers();
    const { controller, forceExit, setExitCode } = makeController();

    controller.handleSignal("SIGTERM");
    controller.concludeAfterFinalize();

    expect(setExitCode).toHaveBeenCalledWith(SHUTDOWN_EXIT_CODE);
    expect(forceExit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(10_000);

    expect(forceExit).toHaveBeenCalledTimes(1);
    expect(forceExit).toHaveBeenCalledWith(SHUTDOWN_EXIT_CODE);
  });

  it("concludeAfterFinalize without a signal is a no-op", () => {
    vi.useFakeTimers();
    const { controller, forceExit, setExitCode } = makeController();

    controller.concludeAfterFinalize();
    vi.advanceTimersByTime(60_000);

    expect(setExitCode).not.toHaveBeenCalled();
    expect(forceExit).not.toHaveBeenCalled();
  });

  it("concludeAfterFinalize is idempotent", () => {
    vi.useFakeTimers();
    const { controller, forceExit, setExitCode } = makeController();

    controller.handleSignal("SIGINT");
    controller.concludeAfterFinalize();
    controller.concludeAfterFinalize();
    vi.advanceTimersByTime(10_000);

    expect(setExitCode).toHaveBeenCalledTimes(1);
    expect(forceExit).toHaveBeenCalledTimes(1);
  });
});

describe("installShutdownHandlers", () => {
  it("registers SIGINT and SIGTERM handlers routed to handleSignal", () => {
    const onSpy = vi.spyOn(process, "on");
    try {
      const { controller, onFirstSignal } = makeController();
      installShutdownHandlers(controller);

      expect(onSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
      expect(onSpy).toHaveBeenCalledWith("SIGTERM", expect.any(Function));

      const sigint = onSpy.mock.calls.find(([signal]) => signal === "SIGINT")?.[1] as (s: string) => void;
      sigint("SIGINT");
      expect(onFirstSignal).toHaveBeenCalledTimes(1);
      expect(controller.isPending()).toBe(true);
    } finally {
      onSpy.mockRestore();
    }
  });
});

describe("createSingleIssueStopHandler", () => {
  const makeDeps = (overrides: Partial<Parameters<typeof createSingleIssueStopHandler>[0]> = {}) => {
    const deps = {
      isRunActive: vi.fn(() => true),
      requestStop: vi.fn(),
      killWorkers: vi.fn(() => 2),
      notify: vi.fn(),
      ...overrides,
    };
    return { deps, handler: createSingleIssueStopHandler(deps) };
  };

  it("first stop during a run requests stop and calls killWorkers exactly once", () => {
    const { deps, handler } = makeDeps();

    expect(() => handler()).not.toThrow();

    expect(deps.requestStop).toHaveBeenCalledTimes(1);
    expect(deps.killWorkers).toHaveBeenCalledTimes(1);
    expect(deps.notify).toHaveBeenCalledWith("Stop requested — aborted current issue (2 workers killed).");
  });

  it("repeated stops while workers are dying stay idempotent and do not crash", () => {
    const { deps, handler } = makeDeps({ killWorkers: vi.fn().mockReturnValueOnce(2).mockReturnValueOnce(0) });

    handler();
    handler();

    expect(deps.killWorkers).toHaveBeenCalledTimes(2);
    expect(deps.requestStop).toHaveBeenCalledTimes(2);
    expect(deps.notify).toHaveBeenNthCalledWith(1, "Stop requested — aborted current issue (2 workers killed).");
    expect(deps.notify).toHaveBeenNthCalledWith(2, "Stop requested — finalizing current issue as failed.");
  });

  it("stop with no active run is ignored and never touches the worker pool", () => {
    const { deps, handler } = makeDeps({ isRunActive: vi.fn(() => false) });

    handler();

    expect(deps.requestStop).not.toHaveBeenCalled();
    expect(deps.killWorkers).not.toHaveBeenCalled();
    expect(deps.notify).toHaveBeenCalledWith("Stop ignored — no run is active.");
  });
});

describe("normalizeWatchedSlug vs webhook slug identity", () => {
  it("lowercases URL/slug inputs so mixed-case config matches lowercased webhook slugs", () => {
    expect(normalizeWatchedSlug("https://github.com/Saif-Ali-109/Demo-Repo.git")).toBe("saif-ali-109/demo-repo");
    expect(normalizeWatchedSlug("Saif-Ali-109/Demo")).toBe("saif-ali-109/demo");

    const watched = new Set([normalizeWatchedSlug("Saif-Ali-109/Demo")]);
    const ev = parseIssueEvent({
      action: "opened",
      issue: { number: 7, title: "t" },
      repository: { full_name: "Saif-Ali-109/Demo" },
    });
    expect(ev).not.toBeNull();
    expect(ev!.slug).toBe("saif-ali-109/demo");
    expect(watched.has(ev!.slug)).toBe(true);
  });

  it("keeps pendingWebhookIssues keying consistent between intake and lookup", () => {
    const ev = parseIssueEvent({
      action: "reopened",
      issue: { number: 26, title: "t" },
      repository: { full_name: "Saif-Ali-109/Demo" },
    })!;
    const pendingWebhookIssues = new Map<string, Map<number, string>>();
    const bySlug = pendingWebhookIssues.get(ev.slug) ?? new Map();
    bySlug.set(ev.number, ev.action);
    pendingWebhookIssues.set(ev.slug, bySlug);

    const lookupKey = normalizeWatchedSlug("github.com/Saif-Ali-109/Demo");
    expect(pendingWebhookIssues.get(lookupKey)?.get(26)).toBe("reopened");
  });
});

describe("quota-pause resume wiring (P-quota)", () => {
  it("resumeFromPause is a no-op (false) when no orchestrator run is active", async () => {
    const { resumeFromPause } = await import("../orchestrator.ts");
    expect(resumeFromPause()).toBe(false);
  });

  it("reloadApiKeyEnv applies only the two provider keys from .env and never throws on a missing file", async () => {
    const { reloadApiKeyEnv, resumeFromPause: _sameSeam } = await import("../orchestrator.ts");
    void _sameSeam;
    const savedGemini = process.env.GEMINI_API_KEY;
    const savedOr = process.env.OPENROUTER_API_KEY;
    try {
      // A directory with no .env file must be a safe no-op.
      const emptyDir = await mkdtemp(join(tmpdir(), "env-empty-"));
      expect(reloadApiKeyEnv(emptyDir)).toEqual([]);
      delete process.env.GEMINI_API_KEY;

      const root = await mkdtemp(join(tmpdir(), "env-keys-"));
      await writeFile(
        join(root, ".env"),
        [
          "# comment line",
          "GEMINI_API_KEY=\"quoted-gemini-key\"",
          "OTHER_KEY=ignored",
          "",
          "OPENROUTER_API_KEY=plain-or-key",
        ].join("\n"),
        "utf8",
      );
      expect(reloadApiKeyEnv(root)).toEqual(["GEMINI_API_KEY", "OPENROUTER_API_KEY"]);
      expect(process.env.GEMINI_API_KEY).toBe("quoted-gemini-key");
      expect(process.env.OPENROUTER_API_KEY).toBe("plain-or-key");
    } finally {
      if (savedGemini === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = savedGemini;
      if (savedOr === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = savedOr;
    }
  });
});

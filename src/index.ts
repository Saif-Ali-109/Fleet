import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebDashboard, type WebhookHandler } from "./dashboard/webDashboard.ts";
import { resolveManagerPath } from "./memory/paths.ts";
import { db, pool } from "./db/client.ts";
import { appendAuditEvent, ensureChain } from "./db/audit.ts";
import type { SorEvent } from "./sor/events.ts";
import { fixBranchName, shouldSkipIssue } from "./daemon/dedup.ts";
import {
  addIssueLabel,
  commentOnIssue,
  ensureLabels,
  fetchIssue,
  ghAuthInfo,
  hasIssueLabel,
  hasOpenPrForBranch,
  ISSUE_LABEL_DONE,
  ISSUE_LABEL_IN_PROGRESS,
  listOpenIssues,
  splitRepoSlug,
  stubIssue,
  toRepoSlug,
} from "./github/gh.ts";
import { verifyWebhookSignature, parseIssueEvent } from "./daemon/webhook.ts";
import { runOrchestrator, resumeFromPause, type WebFeed } from "./orchestrator.ts";
import { pruneOldRunDirs } from "./git/worktree.ts";
import { killActiveWorkers, resetWorkerAbort } from "./agentRunner.ts";
import type { DashboardState } from "./tui/dashboard.ts";
import type { Issue, RunContext } from "./types.ts";
import { loadModelOverrides } from "./models/modelPolicy.ts";
import { PROVIDER_NAMES, type ProviderName } from "./types.ts";
import {
  assertGeminiModelChainConfiguration,
  assertGeminiQuotaConfiguration,
  geminiQuotaConfig,
  geminiRateLimitWaitMs,
} from "./gemini/quotaConfig.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Session-level clone reuse (0.7 worktree hygiene): repoSlug → shared clone dir. */
const sessionClones = new Map<string, string>();

export const SHUTDOWN_EXIT_CODE = 130;

export interface ShutdownControllerOptions {
  isRunning: () => boolean;
  onFirstSignal: () => void;
  forceExit?: (code: number) => void;
  setExitCode?: (code: number) => void;
}

export interface ShutdownController {
  handleSignal(signal: string): void;
  isPending(): boolean;
  concludeAfterFinalize(): void;
}

/**
 * Signal decision logic for graceful shutdown (§1.3). First signal during a
 * run: kill workers and let the orchestrator finalize the run as FAILED
 * through its normal failure path (GitHub comment + DB finalize); the exit
 * code 130 is pinned afterwards via concludeAfterFinalize(), with an unref'd
 * 10s guard forcing exit if lingering handles keep the loop alive. A second
 * signal while a graceful shutdown is still pending exits immediately; a
 * signal with no run in flight exits promptly like the old handler.
 */
export function createShutdownController(opts: ShutdownControllerOptions): ShutdownController {
  const forceExit = opts.forceExit ?? ((code: number) => process.exit(code));
  const setExitCode = opts.setExitCode ?? ((code: number) => { process.exitCode = code; });
  let pending = false;
  let concluded = false;
  return {
    handleSignal(signal: string): void {
      if (!opts.isRunning()) {
        console.log(`[shutdown] ${signal} received — no active run, exiting.`);
        forceExit(SHUTDOWN_EXIT_CODE);
        return;
      }
      if (pending) {
        console.log(`[shutdown] ${signal} received again — forcing exit.`);
        forceExit(SHUTDOWN_EXIT_CODE);
        return;
      }
      pending = true;
      console.log("[shutdown] signal received — stopping workers and finalizing…");
      opts.onFirstSignal();
    },
    isPending: () => pending,
    concludeAfterFinalize(): void {
      if (!pending || concluded) return;
      concluded = true;
      setExitCode(SHUTDOWN_EXIT_CODE);
      const guard = setTimeout(() => forceExit(SHUTDOWN_EXIT_CODE), 10_000);
      guard.unref();
    },
  };
}

export function installShutdownHandlers(controller: ShutdownController): void {
  process.on("SIGINT", (signal) => controller.handleSignal(signal));
  process.on("SIGTERM", (signal) => controller.handleSignal(signal));
}

/**
 * Stop-button handler for single-issue dashboard mode (queue mode wires its
 * own). Each invocation calls killActiveWorkers() exactly once and relies on
 * its built-in idempotency for double clicks while workers are already dying;
 * the orchestrator's normal abort flow then finalizes the run as failed.
 * A click before any run is active is ignored so the abort latch cannot
 * poison a run that has not started yet.
 */
export interface SingleIssueStopDeps {
  isRunActive: () => boolean;
  requestStop: () => void;
  killWorkers: () => number;
  notify?: (message: string) => void;
}

export function createSingleIssueStopHandler(deps: SingleIssueStopDeps): () => void {
  return () => {
    if (!deps.isRunActive()) {
      deps.notify?.("Stop ignored — no run is active.");
      return;
    }
    deps.requestStop();
    const killed = deps.killWorkers();
    deps.notify?.(
      killed > 0
        ? `Stop requested — aborted current issue (${killed} worker${killed === 1 ? "" : "s"} killed).`
        : "Stop requested — finalizing current issue as failed.",
    );
  };
}

/** Watched-repo identity must match webhook slugs, which parseIssueEvent lowercases. */
export const normalizeWatchedSlug = (repoInput: string): string => toRepoSlug(repoInput).toLowerCase();

const usage = (): string => `Usage: npm start [--repo <url> --issue <n>] [--dry-run] [--branch <name>] [--port <n>] [--no-web] [--provider <name>]

  (no args)             Dashboard-driven repo queue: paste a repo URL in the
                        dashboard and it fixes every open issue, one by one.
  --repo <url>          Repo URL (https://...) or owner/name slug.
  --issue <n>           GitHub issue number to fix.
  --dry-run              Skip cloning, workers and gh; use stubs.
  --branch <name>        Fix branch name (default fix-issue-<n>).
  --port <n>             Web dashboard port (default 3456).
  --no-web               Disable the web dashboard.
  --provider <name>      Provider to run the fleet workers:
                         gemini | openrouter | ollama (default gemini,
                         or ORCHESTRATOR_PROVIDER env).
  --help                 Show this help.`;

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const newRunId = (): string => new Date().toISOString().replace(/[:.]/g, "-");

const scanIntervalMinutes = Math.max(1, Number(process.env.SCAN_INTERVAL_MINUTES) || 5);
const scanIntervalMs = scanIntervalMinutes * 60_000;
let stopRequested = false;
let daemonActive = false;

// Webhook intake (hybrid trigger): issues accepted by POST /webhook wait here
// until the daemon loop drains them at the top of the next cycle. The loop
// atomically swaps in a fresh map before draining, so arrivals mid-drain are
// picked up next cycle instead of being lost. wakeScan short-circuits the
// 5-min poll sleep; single-slot resolver coalesces mid-scan wakes.
type WebhookAction = "opened" | "reopened";
let pendingWebhookIssues = new Map<string, Map<number, WebhookAction>>();
let wakeResolve: (() => void) | null = null;
const wakeScan = (): void => {
  if (!wakeResolve) return;
  const r = wakeResolve;
  wakeResolve = null;
  r();
};

let runActive = false;

export const shutdownController = createShutdownController({
  isRunning: () => runActive || daemonActive,
  onFirstSignal: () => {
    stopRequested = true;
    killActiveWorkers();
    wakeScan();
  },
});

/** Test-only seam (mirrors FLEET_WORKER_ENTRY): never set by production code;
 * keeps vitest workers from registering real signal handlers on import. */
if (!process.env.FLEET_SKIP_SHUTDOWN_HANDLERS) {
  installShutdownHandlers(shutdownController);
}

/** Action-aware dedup shared by webhook intake and drain. Reopened issues
 * bypass the done-label + completed-row checks (a reopen means "fix was
 * wrong") but keep the open-PR guard. Throws on gh/db failure — callers
 * decide whether that means skip or process. */
const eligibleForWebhookRun = async (
  slug: string,
  num: number,
  action: WebhookAction,
): Promise<boolean> => {
  if (action === "reopened") {
    return (await hasOpenPrForBranch(slug, fixBranchName(num))) !== true;
  }
  const completedRun = await db.hasCompletedRun(slug, num);
  return !(await shouldSkipIssue({ repoUrlOrSlug: slug, issueNumber: num, completedRun }));
};

const readVersion = (): string => {
  try {
    const pkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
};

/** Append a signed `wakeup` event to the audit chain (requires SOR_SIGNING_KEY). */
const emitWakeup = async (actor: string, payload: Record<string, unknown>): Promise<void> => {
  const event: SorEvent = {
    run_id: null,
    event_type: "wakeup",
    actor,
    backend: null,
    tool_name: null,
    tool_input: null,
    tool_output: null,
    payload,
    created_at: new Date().toISOString(),
  };
  await appendAuditEvent(pool, event);
};

/** Fire-and-forget wakeup emit; failures log a warning and never abort the flow. */
const emitWakeupNonFatal = (actor: string, payload: Record<string, unknown>): void => {
  void emitWakeup(actor, payload).catch((err: unknown) => {
    console.warn(
      `[sor] wakeup ${String(payload.kind ?? "")} skipped (${actor}): ${err instanceof Error ? err.message : String(err)}`,
    );
  });
};

/** Boot: ensure the sor_chain singleton, then record a `boot` wakeup. Non-fatal. */
const bootSOR = (mode: string): void => {
  void (async () => {
    try {
      await ensureChain(pool);
      await emitWakeup("system", { kind: "boot", version: readVersion(), mode });
    } catch (err: unknown) {
      console.warn(`[sor] boot wakeup skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
};

function isModelLimitError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes("rate limit") ||
    lower.includes("429") ||
    lower.includes("token limit") ||
    lower.includes("context length") ||
    lower.includes("quota") ||
    lower.includes("model limit") ||
    lower.includes("too many requests")
  );
}

const toRepoUrl = (repo: string): string =>
  /^https?:\/\//.test(repo) ? repo : `https://github.com/${repo.trim().replace(/\.git$/, "")}.git`;

interface BootedWeb {
  web: WebDashboard | null;
  webFeed: WebFeed | undefined;
}

// Resume click → orchestrator pause exit (SPEC §11.5): the key-reload +
// coordinator-reset + waiter-resolve sequence lives inside resumeFromPause().
const onResumeClick = (): boolean => resumeFromPause();

/** Boot the web dashboard (if the port is free) and build the orchestrator feed. */
async function bootWeb(port: number): Promise<BootedWeb> {
  let web: WebDashboard | null = null;
  const onStop = createSingleIssueStopHandler({
    isRunActive: () => runActive,
    requestStop: () => {
      stopRequested = true;
    },
    killWorkers: killActiveWorkers,
    notify: (message) => web?.pushNotice(message),
  });
  web = new WebDashboard(port, rootDir, undefined, undefined, onStop, undefined, onResumeClick);
  const info = await web.start();
  if (info) {
    console.log(`\n▶ Dashboard: ${info.url} (live)`);
    return {
      web,
      webFeed: {
        pushState: (d) => web?.pushState(d),
        pushOutput: (role, text) => web?.pushOutput(role, text),
        pushAgentEvent: (role, ev) => web?.pushAgentEvent(role, ev),
        pushFinal: (phase, prUrl) => web?.pushFinal(phase, prUrl),
        pushQuotaEvent: (event) => web?.pushQuotaEvent(event),
        pushPause: (paused, message) => web?.setPaused(paused, message),
      },
    };
  }
  console.log(`\n▶ Dashboard: (disabled: could not bind 127.0.0.1:${port})`);
  return { web: null, webFeed: undefined };
}

async function runSingleIssue(args: {
  repo: string;
  issueNumber: number;
  dryRun: boolean;
  branch?: string;
  port: number;
  noWeb?: boolean;
  provider: ProviderName;
}): Promise<void> {
  const { repo, issueNumber, dryRun, branch, port, noWeb, provider } = args;
  const repoUrl = toRepoUrl(repo);
  const runId = newRunId();
  const { web, webFeed } = noWeb ? { web: null, webFeed: undefined } : await bootWeb(port);

  let issue: Issue;
  if (dryRun) {
    issue = stubIssue(repo, issueNumber);
  } else {
    let ghInfo = await ghAuthInfo();
    if (!ghInfo.ok) {
      web?.pushGh(ghInfo);
      console.log("▶ GitHub: not signed in — run gh auth login; waiting…");
      const deadline = Date.now() + 30 * 60 * 1000;
      while (true) {
        if (Date.now() >= deadline) {
          console.error("GitHub not signed in after 30 minutes; exiting.");
          process.exit(1);
        }
        await sleep(5000);
        ghInfo = await ghAuthInfo();
        if (ghInfo.ok) break;
      }
    }
    web?.pushGh(ghInfo);
    if (ghInfo.ok) console.log("▶ GitHub: signed in as @" + ghInfo.username + " — starting run");

    issue = await fetchIssue(repo, issueNumber);

    // 0.8: warn (don't block) when the issue already carries the done label —
    // it may have been resolved elsewhere, but the user asked for this run.
    try {
      const { owner, repo: repoName } = splitRepoSlug(repo);
      const alreadyDone = await hasIssueLabel(owner, repoName, issueNumber, ISSUE_LABEL_DONE);
      if (alreadyDone) {
        console.warn(
          `⚠ Issue #${issueNumber} already has the \`${ISSUE_LABEL_DONE}\` label — it may already be fixed. Re-running anyway.`,
        );
        web?.pushNotice(`⚠ Issue #${issueNumber} already has \`${ISSUE_LABEL_DONE}\` — re-running anyway.`);
      }
    } catch (err: unknown) {
      console.warn(
        `[lifecycle] done-label check for #${issueNumber} failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const ctx: RunContext = {
    runId,
    issue,
    repoUrl,
    rootDir,
    runDir: join(rootDir, ".runs", runId),
    worktreeDir: join(rootDir, ".runs", runId, "worktree"),
    tracesDir: join(rootDir, ".runs", runId, "traces"),
    branch: branch ?? `fix-issue-${issue.number}`,
    dryRun,
    provider,
  };

  runActive = true;
  const summary = await runOrchestrator(ctx, { web: webFeed }).finally(() => {
    runActive = false;
  });

  console.log("\n┌─ Run finished ─────────────────────────────");
  console.log(`│ status:      ${summary.status}`);
  if (summary.prUrl) console.log(`│ PR:          ${summary.prUrl}`);
  console.log(`│ backend:     ${summary.backend}`);
  console.log(`│ total cost:  $${summary.totalCostUsd.toFixed(4)}`);
  console.log(`│ iterations:  ${summary.iterationsUsed}`);
  console.log(`│ run dir:     ${ctx.runDir}`);
  if (summary.failure) console.log(`│ failure:     ${summary.failure}`);
  console.log("└─────────────────────────────────────────────");

  if (web) {
    const phase: DashboardState["phase"] =
      summary.status === "completed" ? "done" : summary.status === "aborted" ? "aborted" : "failed";
    web.pushFinal(phase, summary.prUrl);
    await sleep(15000);
    await web.close();
  }

  process.exitCode = summary.status === "completed" ? 0 : summary.status === "aborted" ? 2 : 1;
  shutdownController.concludeAfterFinalize();
}

/** Dashboard-driven daemon: watch a repo, auto-scan for open issues, fix them one by one until Stop. */
async function runQueue(port: number, dryRun: boolean, provider: ProviderName): Promise<void> {
  let web: WebDashboard | null = null;
  let webFeed: WebFeed | undefined;
  const watched = new Set<string>();
  let selectedProvider = provider;

  const startHandler = async (
    repoInput: string,
    chosenProvider?: ProviderName,
  ): Promise<{ ok: boolean; error?: string; runStarted?: boolean }> => {
    try {
      const effectiveProvider = chosenProvider ?? selectedProvider;
      selectedProvider = effectiveProvider;
      const slug = normalizeWatchedSlug(repoInput);
      const ghInfo = await ghAuthInfo();
      if (!ghInfo.ok) return { ok: false, error: ghInfo.error ?? "GitHub not signed in" };
      web?.pushGh(ghInfo);
      web?.pushNotice("");
      try {
        await listOpenIssues(slug);
      } catch (err: any) {
        return { ok: false, error: `repo not found or inaccessible: ${err?.message ?? err}` };
      }
      watched.add(slug);
      stopRequested = false;
      resetWorkerAbort();
      if (!daemonActive) {
        daemonActive = true;
        void runDaemonLoop(watched, dryRun, () => selectedProvider, web, webFeed, port).catch((err: unknown) => {
          daemonActive = false;
          console.error(err);
          web?.pushNotice("Daemon crashed: " + (err instanceof Error ? err.message : err));
        });
      } else {
        web?.pushNotice(`${slug} added to the watch list.`);
      }
      return { ok: true, runStarted: true };
    } catch (err: any) {
      return { ok: false, error: String(err instanceof Error ? err.message : err) };
    }
  };

  /** Action-aware dedup shared by webhook intake and drain. Reopened issues
   * bypass the done-label + completed-row checks (a reopen means "fix was
   * wrong") but keep the open-PR guard. Throws on gh/db failure — callers
   * decide whether that means skip or process. */
  const onWebhook: WebhookHandler = async (headers: Record<string, string | string[] | undefined>, rawBody: string) => {
    const secret = process.env.WEBHOOK_SECRET;
    if (!secret) return { status: 503, body: { error: "webhook not configured" } };
    const sigHeader = Array.isArray(headers["x-hub-signature-256"])
      ? headers["x-hub-signature-256"][0]
      : headers["x-hub-signature-256"];
    if (!verifyWebhookSignature(rawBody, sigHeader, secret)) {
      return { status: 401, body: { error: "invalid signature" } };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return { status: 200, body: { ignored: true } };
    }
    const ev = parseIssueEvent(parsed);
    if (!ev) return { status: 200, body: { ignored: true } };
    // Whitelist against the LIVE watched set (repos can be added at runtime).
    if (!watched.has(ev.slug)) return { status: 200, body: { ignored: true } };
    try {
      if (!(await eligibleForWebhookRun(ev.slug, ev.number, ev.action))) {
        return { status: 200, body: { ignored: true } };
      }
    } catch {
      // gh/db hiccup during intake — safest to ignore; the poll loop re-checks.
      return { status: 200, body: { ignored: true } };
    }
    const bySlug = pendingWebhookIssues.get(ev.slug) ?? new Map<number, WebhookAction>();
    bySlug.set(ev.number, ev.action);
    pendingWebhookIssues.set(ev.slug, bySlug);
    emitWakeupNonFatal("webhook", {
      kind: "issue",
      repo: ev.slug,
      issue: ev.number,
      action: ev.action,
    });
    wakeScan();
    return { status: 200, body: { queued: true } };
  };

  web = new WebDashboard(port, rootDir, startHandler, provider, () => {
    stopRequested = true;
    const killed = killActiveWorkers();
    web?.pushNotice(
      killed > 0
        ? `Stop requested — aborted current issue (${killed} worker${killed === 1 ? "" : "s"} killed).`
        : "Stop requested — daemon stopping.",
    );
  }, onWebhook, onResumeClick);
  const info = await web.start();
  if (info) {
    console.log(`\n▶ Dashboard: ${info.url} (live)`);
    console.log("▶ Queue mode: paste a repo URL in the dashboard and press Start.");
    webFeed = {
      pushState: (d) => web?.pushState(d),
      pushOutput: (role, text) => web?.pushOutput(role, text),
      pushAgentEvent: (role, ev) => web?.pushAgentEvent(role, ev),
      pushFinal: (phase, prUrl) => web?.pushFinal(phase, prUrl),
      pushQuotaEvent: (event) => web?.pushQuotaEvent(event),
      pushPause: (paused, message) => web?.setPaused(paused, message),
    };
  } else {
    console.log(`\n▶ Dashboard: (disabled: could not bind 127.0.0.1:${port})`);
    console.log("▶ Queue mode needs the dashboard. Exiting.");
    process.exit(1);
  }

  const ghInfo = await ghAuthInfo();
  web.pushGh(ghInfo);
  if (ghInfo.ok) {
    console.log(`▶ GitHub: signed in as @${ghInfo.username}`);
  } else {
    console.log(`▶ GitHub: ${ghInfo.error}`);
    web.pushNotice(`GitHub not signed in — ${ghInfo.error} — use the Log in button above.`);
  }
}

async function runDaemonLoop(
  repos: ReadonlySet<string>,
  dryRun: boolean,
  getProvider: () => ProviderName,
  web: WebDashboard | null,
  webFeed: WebFeed | undefined,
  port: number,
): Promise<void> {
  let scanCycle = 0;
  try {
    while (!stopRequested) {
      scanCycle += 1;
      emitWakeupNonFatal("daemon", { kind: "scan", cycle: scanCycle });
      if (!dryRun) {
        try {
          const { removed, errors } = await pruneOldRunDirs(join(rootDir, ".runs"));
          if (removed.length > 0) {
            web?.pushNotice(`Pruned ${removed.length} old run director${removed.length === 1 ? "y" : "ies"} from .runs/`);
          }
          for (const err of errors) console.warn(`[runs-retention] ${err}`);
        } catch (e) {
          console.warn(`[runs-retention] sweep failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      // Drain webhook-queued issues first (hybrid trigger). Atomic swap so
      // arrivals during the drain land in the fresh map for the next cycle
      // instead of being lost. Drain-time re-check is authoritative.
      const batch = pendingWebhookIssues;
      pendingWebhookIssues = new Map();
      for (const [slug, nums] of batch) {
        if (stopRequested) break;
        for (const [num, action] of nums) {
          if (stopRequested) break;
          let title = "";
          if (!dryRun) {
            try {
              const issue = await fetchIssue(slug, num);
              if (issue.state === "closed") {
                web?.pushNotice(`Skipping webhook #${num} (closed since intake).`);
                continue;
              }
              title = issue.title ?? "";
              if (!(await eligibleForWebhookRun(slug, num, action))) {
                web?.pushNotice(`Skipping webhook #${num} (already fixed).`);
                continue;
              }
            } catch (err: unknown) {
              web?.pushNotice(
                `⚠ webhook re-check for #${num} failed: ${err instanceof Error ? err.message : err}`,
              );
              continue;
            }
          }
          try {
            const currentProvider = getProvider();
            const res = await runSingleIssueFromQueue(slug, num, title, dryRun, currentProvider, web, webFeed);
            if (res.status === "completed") {
              web?.pushNotice(`✓ Webhook issue #${num} → PR: ${res.prUrl ?? "(none)"}`);
            } else {
              web?.pushNotice(`✗ Webhook issue #${num} failed: ${res.failure ?? res.status}`);
            }
          } catch (err: unknown) {
            // Per-issue isolation: one bad issue never blocks the rest of the
            // batch; the poll loop re-picks it if still eligible.
            web?.pushNotice(`⛔ Webhook #${num} failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
      for (const slug of repos) {
        if (stopRequested) break;
        let issues: { number: number; title: string }[];
        try {
          issues = await listOpenIssues(slug);
        } catch (err: unknown) {
          web?.pushNotice(`⚠ scan failed: ${err instanceof Error ? err.message : err}`);
          web?.pushNotice("Skipping this scan — will retry at the next interval.");
          issues = [];
        }
        for (const item of issues) {
          if (stopRequested) break;
          const num = item.number;
          const title = item.title ?? "";
          if (!dryRun) {
            try {
              const completedRun = await db.hasCompletedRun(slug, num);
              if (await shouldSkipIssue({ repoUrlOrSlug: slug, issueNumber: num, completedRun })) {
                web?.pushNotice(`Skipping #${num} (already fixed).`);
                continue;
              }
            } catch (err: unknown) {
              web?.pushNotice(
                `⚠ skip check for #${num} failed: ${err instanceof Error ? err.message : err}`,
              );
            }
          }
          try {
            const currentProvider = getProvider();
            const res = await runSingleIssueFromQueue(slug, num, title, dryRun, currentProvider, web, webFeed);
            if (res.status === "completed") {
              web?.pushNotice(`✓ Issue #${num} → PR: ${res.prUrl ?? "(none)"}`);
            } else {
              web?.pushNotice(`✗ Issue #${num} failed: ${res.failure ?? res.status}`);
              web?.pushNotice("Continuing to next issue…");
            }
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            web?.pushNotice(`⛔ #${num} failed: ${errMsg}`);
            // Check if this is a model limit error and POST to dashboard
            if (isModelLimitError(errMsg) && web) {
              fetch(`http://127.0.0.1:${port}/api/model-limit-error`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  type: "model_limit",
                  message: errMsg,
                  agent: getProvider(),
                  issue: num,
                  timestamp: Date.now(),
                }),
              }).catch((e) => console.error("Failed to post model limit error:", e));
            }
          }
        }
        web?.pushNotice(
          `Scan ${slug} — ${issues.length} issue${issues.length === 1 ? "" : "s"} processed.`,
        );
      }
      // Wakeable poll sleep: a webhook intake short-circuits the wait via
      // wakeScan(); the timeout keeps the 5-min safety-net cadence. The
      // dashboard gets the deadline for its live countdown.
      web?.pushNextScanAt(Date.now() + scanIntervalMs);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          wakeResolve = null;
          resolve();
        }, scanIntervalMs);
        wakeResolve = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wakeResolve = null;
      web?.pushNextScanAt(null);
    }
  } finally {
    daemonActive = false;
    web?.pushNotice("Daemon stopped — idle. Press Start to resume.");
  }
}

async function runSingleIssueFromQueue(
  slug: string,
  num: number,
  title: string,
  dryRun: boolean,
  provider: ProviderName,
  web: WebDashboard | null,
  webFeed: WebFeed | undefined,
): Promise<{ status: string; prUrl?: string; failure?: string }> {
  web?.pushNotice(`Fixing issue — #${num}: ${title}`);
  const issue = await fetchIssue(slug, num);
  const runId = newRunId();

  // Session-level clone reuse (0.7): the first run for a repo clones into its
  // runDir and records it here; later runs reuse that clone (fetch + worktree
  // add — no second clone). Dry-run never clones, so the map is untouched.
  // A stale entry (previous run failed before the clone materialized) self-heals
  // via the `.git` existence check → fresh clone.
  let sharedClone: string | undefined;
  if (!dryRun) {
    const known = sessionClones.get(slug);
    if (known && existsSync(join(known, ".git"))) {
      sharedClone = known;
    } else {
      sessionClones.set(slug, join(rootDir, ".runs", runId, "repo"));
      sharedClone = undefined;
    }
  }

  const ctx: RunContext = {
    runId,
    issue,
    repoUrl: toRepoUrl(slug),
    rootDir,
    runDir: join(rootDir, ".runs", runId),
    worktreeDir: join(rootDir, ".runs", runId, "worktree"),
    tracesDir: join(rootDir, ".runs", runId, "traces"),
    branch: fixBranchName(num),
    dryRun,
    provider,
    cloneDir: sharedClone,
  };

  // Issue lifecycle mark-started (0.1): non-fatal and dry-run safe. A gh
  // failure here only warns — it must never abort the run.
  if (!dryRun) {
    const { owner, repo } = splitRepoSlug(slug);
    try {
      await ensureLabels(owner, repo, [ISSUE_LABEL_IN_PROGRESS, ISSUE_LABEL_DONE]);
      await addIssueLabel(owner, repo, num, ISSUE_LABEL_IN_PROGRESS);
      await commentOnIssue(owner, repo, num, `Started managed run \`${runId}\` (provider: ${provider}).`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[lifecycle] mark-started #${num} failed (non-fatal): ${msg}`);
      web?.pushNotice(`⚠ lifecycle mark-started failed (non-fatal): ${msg}`);
    }
  }

  runActive = true;
  const s = await runOrchestrator(ctx, { web: webFeed }).finally(() => {
    runActive = false;
  });
  console.log("\n┌─ Issue #" + num + " finished ───────────────────────");
  console.log(`│ status:      ${s.status}`);
  if (s.prUrl) console.log(`│ PR:          ${s.prUrl}`);
  console.log(`│ backend:     ${s.backend}`);
  console.log(`│ total cost:  $${s.totalCostUsd.toFixed(4)}`);
  if (s.failure) console.log(`│ failure:     ${s.failure}`);
  console.log("└─────────────────────────────────────────────");

  if (webFeed?.pushFinal) {
    const phase: DashboardState["phase"] =
      s.status === "completed" ? "done" : s.status === "aborted" ? "aborted" : "failed";
    webFeed.pushFinal(phase, s.prUrl);
  }

  shutdownController.concludeAfterFinalize();
  return { status: s.status, prUrl: s.prUrl, failure: s.failure };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) {
    console.log(usage());
    return;
  }

  let repo: string | undefined;
  let issueNumber: number | undefined;
  let dryRun = false;
  let branch: string | undefined;
  let port = 3456;
  let noWeb = false;
  const envProvider = (process.env.ORCHESTRATOR_PROVIDER as ProviderName | undefined) ?? "gemini";
  let provider: ProviderName = PROVIDER_NAMES.includes(envProvider) ? envProvider : "gemini";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) {
      console.error(`Unknown flag: ${arg}\n`);
      console.error(usage());
      process.exit(1);
    }
    if (arg === "--repo") {
      i += 1;
      repo = argv[i];
      if (!repo) {
        console.error("--repo requires a value\n");
        console.error(usage());
        process.exit(1);
      }
    } else if (arg === "--issue") {
      i += 1;
      const v = argv[i];
      if (v === undefined || !/^\d+$/.test(v)) {
        console.error("--issue requires a positive integer\n");
        console.error(usage());
        process.exit(1);
      }
      issueNumber = Number(v);
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--branch") {
      i += 1;
      branch = argv[i];
      if (!branch) {
        console.error("--branch requires a value\n");
        console.error(usage());
        process.exit(1);
      }
    } else if (arg === "--port") {
      i += 1;
      const v = argv[i];
      if (v === undefined || !/^\d+$/.test(v)) {
        console.error("--port requires a positive integer\n");
        console.error(usage());
        process.exit(1);
      }
      port = Number(v);
    } else if (arg === "--provider") {
      i += 1;
      const v = argv[i];
      if (v === undefined || !PROVIDER_NAMES.includes(v as ProviderName)) {
        console.error(`--provider must be one of: ${PROVIDER_NAMES.join(", ")}\n`);
        console.error(usage());
        process.exit(1);
      }
      provider = v as ProviderName;
    } else if (arg === "--no-web") {
      noWeb = true;
    } else {
      console.error(`Unknown flag: ${arg}\n`);
      console.error(usage());
      process.exit(1);
    }
  }

  loadModelOverrides(resolveManagerPath(rootDir, "models.json"));

  const mode = repo !== undefined && issueNumber !== undefined ? "single" : "queue";
  // Dry-run must stay keyless/green: quota + model-chain validation only gate real runs.
  if (provider === "gemini" && !dryRun) {
    geminiRateLimitWaitMs();
    assertGeminiQuotaConfiguration(undefined, geminiQuotaConfig());
    assertGeminiModelChainConfiguration(undefined, geminiQuotaConfig());
  }
  bootSOR(mode);

  if (repo === undefined && issueNumber === undefined) {
    if (noWeb) {
      console.error("Missing --repo (and --no-web cannot be used without a repo)\n");
      console.error(usage());
      process.exit(1);
    }
    emitWakeupNonFatal("daemon", { kind: "config.load" });
    await runQueue(port, dryRun, provider);
    return;
  }
  if (repo === undefined) {
    console.error("Missing --repo\n");
    console.error(usage());
    process.exit(1);
  }
  if (issueNumber === undefined) {
    console.error("Missing --issue\n");
    console.error(usage());
    process.exit(1);
  }

  await runSingleIssue({
    repo,
    issueNumber,
    dryRun,
    branch,
    port,
    noWeb,
    provider,
  });
}

try {
  await main();
  shutdownController.concludeAfterFinalize();
} catch (e) {
  console.error(e);
  process.exit(shutdownController.isPending() ? SHUTDOWN_EXIT_CODE : 1);
}

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
import { runOrchestrator, type WebFeed } from "./orchestrator.ts";
import { killActiveWorkers, resetWorkerAbort } from "./agentRunner.ts";
import type { DashboardState } from "./tui/dashboard.ts";
import type { Issue, RunContext } from "./types.ts";
import { loadModelOverrides } from "./models/modelPolicy.ts";
import type { Backend } from "./types.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Session-level clone reuse (0.7 worktree hygiene): repoSlug → shared clone dir. */
const sessionClones = new Map<string, string>();

process.on("SIGINT", () => process.exit(130));

const usage = (): string => `Usage: npm start [--repo <url> --issue <n>] [--dry-run] [--interactive=false] [--branch <name>] [--port <n>] [--no-web] [--backend <name>]

  (no args)             Dashboard-driven repo queue: paste a repo URL in the
                        dashboard and it fixes every open issue, one by one.
  --repo <url>          Repo URL (https://...) or owner/name slug.
  --issue <n>           GitHub issue number to fix.
  --dry-run              Skip cloning, workers and gh; use stubs.
  --interactive=false    Auto-approve all gates.
  --branch <name>        Fix branch name (default fix-issue-<n>).
  --port <n>             Web dashboard port (default 3456).
  --no-web               Disable the web dashboard.
  --backend <name>       Headless CLI that runs the fleet workers:
                         opencode | claude | codex (default opencode,
                         or ORCHESTRATOR_BACKEND env).
  --help                 Show this help.`;

const BACKENDS: readonly Backend[] = ["opencode", "claude", "codex"];

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
  const run = await db.getRunByRepoIssue(slug, num);
  const completedRun = run?.status === "completed";
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

/** Boot the web dashboard (if the port is free) and build the orchestrator feed. */
async function bootWeb(port: number): Promise<BootedWeb> {
  const web = new WebDashboard(port, rootDir);
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
  interactive: boolean;
  branch?: string;
  port: number;
  noWeb?: boolean;
  backend: Backend;
}): Promise<void> {
  const { repo, issueNumber, dryRun, interactive, branch, port, noWeb, backend } = args;
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
    backend,
  };

  const summary = await runOrchestrator(ctx, { interactive, web: webFeed });

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
}

/** Dashboard-driven daemon: watch a repo, auto-scan for open issues, fix them one by one until Stop. */
async function runQueue(port: number, dryRun: boolean, backend: Backend): Promise<void> {
  let web: WebDashboard | null = null;
  let webFeed: WebFeed | undefined;
  const watched = new Set<string>();

  const startHandler = async (
    repoInput: string,
    chosenBackend?: Backend,
  ): Promise<{ ok: boolean; error?: string; runStarted?: boolean }> => {
    try {
      const effectiveBackend = chosenBackend ?? backend;
      const slug = toRepoSlug(repoInput);
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
        void runDaemonLoop(watched, dryRun, effectiveBackend, web, webFeed, port).catch((err: unknown) => {
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
  const onWebhook: WebhookHandler = async (headers, rawBody) => {
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

  web = new WebDashboard(port, rootDir, startHandler, backend, () => {
    stopRequested = true;
    const killed = killActiveWorkers();
    web?.pushNotice(
      killed > 0
        ? `Stop requested — aborted current issue (${killed} worker${killed === 1 ? "" : "s"} killed).`
        : "Stop requested — daemon stopping.",
    );
  }, onWebhook);
  const info = await web.start();
  if (info) {
    console.log(`\n▶ Dashboard: ${info.url} (live)`);
    console.log("▶ Queue mode: paste a repo URL in the dashboard and press Start.");
    webFeed = {
      pushState: (d) => web?.pushState(d),
      pushOutput: (role, text) => web?.pushOutput(role, text),
      pushAgentEvent: (role, ev) => web?.pushAgentEvent(role, ev),
      pushFinal: (phase, prUrl) => web?.pushFinal(phase, prUrl),
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
  backend: Backend,
  web: WebDashboard | null,
  webFeed: WebFeed | undefined,
  port: number,
): Promise<void> {
  let scanCycle = 0;
  try {
    while (!stopRequested) {
      scanCycle += 1;
      emitWakeupNonFatal("daemon", { kind: "scan", cycle: scanCycle });
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
            const res = await runSingleIssueFromQueue(slug, num, title, dryRun, backend, web, webFeed);
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
              const run = await db.getRunByRepoIssue(slug, num);
              const completedRun = run?.status === "completed";
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
            const res = await runSingleIssueFromQueue(slug, num, title, dryRun, backend, web, webFeed);
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
                  agent: backend,
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
  backend: Backend,
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
    backend,
    cloneDir: sharedClone,
  };

  // Issue lifecycle mark-started (0.1): non-fatal and dry-run safe. A gh
  // failure here only warns — it must never abort the run.
  if (!dryRun) {
    const { owner, repo } = splitRepoSlug(slug);
    try {
      await ensureLabels(owner, repo, [ISSUE_LABEL_IN_PROGRESS, ISSUE_LABEL_DONE]);
      await addIssueLabel(owner, repo, num, ISSUE_LABEL_IN_PROGRESS);
      await commentOnIssue(owner, repo, num, `Started managed run \`${runId}\` (backend: ${backend}).`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[lifecycle] mark-started #${num} failed (non-fatal): ${msg}`);
      web?.pushNotice(`⚠ lifecycle mark-started failed (non-fatal): ${msg}`);
    }
  }

  const s = await runOrchestrator(ctx, { interactive: false, web: webFeed });
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
  let interactive: boolean | undefined;
  let branch: string | undefined;
  let port = 3456;
  let noWeb = false;
  const envBackend = (process.env.ORCHESTRATOR_BACKEND as Backend | undefined) ?? "opencode";
  let backend: Backend = BACKENDS.includes(envBackend) ? envBackend : "opencode";

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
    } else if (arg.startsWith("--interactive=")) {
      const v = arg.slice("--interactive=".length);
      if (v !== "true" && v !== "false") {
        console.error(`--interactive must be true or false, got "${v}"\n`);
        console.error(usage());
        process.exit(1);
      }
      interactive = v === "true";
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
    } else if (arg === "--backend") {
      i += 1;
      const v = argv[i];
      if (v === undefined || !BACKENDS.includes(v as Backend)) {
        console.error(`--backend must be one of: ${BACKENDS.join(", ")}\n`);
        console.error(usage());
        process.exit(1);
      }
      backend = v as Backend;
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
  bootSOR(mode);

  if (repo === undefined && issueNumber === undefined) {
    if (noWeb) {
      console.error("Missing --repo (and --no-web cannot be used without a repo)\n");
      console.error(usage());
      process.exit(1);
    }
    emitWakeupNonFatal("daemon", { kind: "config.load" });
    await runQueue(port, dryRun, backend);
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
    interactive: interactive !== false,
    branch,
    port,
    noWeb,
    backend,
  });
}

await main().catch((e) => {
  console.error(e);
  process.exit(1);
});

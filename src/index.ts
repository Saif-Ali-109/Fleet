import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebDashboard } from "./dashboard/webDashboard.js";
import { fetchIssue, ghAuthInfo, listOpenIssues, stubIssue, toRepoSlug } from "./github/gh.js";
import { runOrchestrator, type WebFeed } from "./orchestrator.js";
import type { DashboardState } from "./tui/dashboard.js";
import type { Issue, RunContext } from "./types.js";
import { loadModelOverrides } from "./models/modelPolicy.js";
import type { Backend } from "./types.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

/** Dashboard-driven queue: fix every open issue of a repo, one by one, gates auto-approved. */
async function runQueue(port: number, dryRun: boolean, backend: Backend): Promise<void> {
  let web: WebDashboard | null = null;
  let webFeed: WebFeed | undefined;

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
      let issues: { number: number; title: string }[];
      try {
        issues = await listOpenIssues(slug);
      } catch (err: any) {
        return { ok: false, error: `repo not found or inaccessible: ${err?.message ?? err}` };
      }
      if (issues.length === 0) {
        web?.pushNotice(`No open issues found in ${slug}. You can enter another repo below.`);
        return { ok: true };
      }
      void runQueueLoop(slug, issues, dryRun, effectiveBackend, web, webFeed).catch((err: unknown) => {
        console.error(err);
        web?.pushNotice(`Queue aborted: ${err instanceof Error ? err.message : err}`);
      });
      return { ok: true, runStarted: true };
    } catch (err: any) {
      return { ok: false, error: String(err instanceof Error ? err.message : err) };
    }
  };

  web = new WebDashboard(port, rootDir, startHandler, backend);
  const info = await web.start();
  if (info) {
    console.log(`\n▶ Dashboard: ${info.url} (live)`);
    console.log("▶ Queue mode: paste a repo URL in the dashboard and press Start.");
    webFeed = {
      pushState: (d) => web?.pushState(d),
      pushOutput: (role, text) => web?.pushOutput(role, text),
      pushAgentEvent: (role, ev) => web?.pushAgentEvent(role, ev),
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

async function runQueueLoop(
  slug: string,
  issues: { number: number; title: string }[],
  dryRun: boolean,
  backend: Backend,
  web: WebDashboard | null,
  webFeed: WebFeed | undefined,
): Promise<void> {
  let completed = 0;
  let failed = 0;
  let index = 0;
  for (const item of issues) {
    index += 1;
    const num = item.number;
    const title = item.title ?? "";
    web?.pushNotice(`Fixing issue ${index} of ${issues.length} — #${num}: ${title}`);
    const issue = await fetchIssue(slug, num);
    const runId = newRunId();
    const ctx: RunContext = {
      runId,
      issue,
      repoUrl: toRepoUrl(slug),
      rootDir,
      runDir: join(rootDir, ".runs", runId),
      worktreeDir: join(rootDir, ".runs", runId, "worktree"),
      tracesDir: join(rootDir, ".runs", runId, "traces"),
      branch: `fix-issue-${num}`,
      dryRun,
      backend,
    };
    const s = await runOrchestrator(ctx, { interactive: false, web: webFeed });
    console.log("\n┌─ Issue #" + num + " finished ───────────────────────");
    console.log(`│ status:      ${s.status}`);
    if (s.prUrl) console.log(`│ PR:          ${s.prUrl}`);
    console.log(`│ backend:     ${s.backend}`);
    console.log(`│ total cost:  $${s.totalCostUsd.toFixed(4)}`);
    if (s.failure) console.log(`│ failure:     ${s.failure}`);
    console.log("└─────────────────────────────────────────────");
    if (s.status === "completed") {
      completed += 1;
      web?.pushNotice(`✓ Issue #${num} → PR: ${s.prUrl ?? "(none)"}`);
    } else {
      failed += 1;
      web?.pushNotice(`✗ Issue #${num} failed: ${s.failure ?? s.status}`);
      web?.pushNotice("Continuing to next issue…");
    }
  }
  web?.pushNotice(`Queue finished — ${completed} completed, ${failed} failed`);
  await sleep(15000);
  await web?.close();
  process.exit(failed === 0 ? 0 : 1);
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

  loadModelOverrides(join(rootDir, "models.json"));

  if (repo === undefined && issueNumber === undefined) {
    if (noWeb) {
      console.error("Missing --repo (and --no-web cannot be used without a repo)\n");
      console.error(usage());
      process.exit(1);
    }
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

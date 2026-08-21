import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { Issue } from "../types.ts";

const execFileAsync = promisify(execFile);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function gh(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync("gh", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

/** Normalize a repo URL or `owner/name` into `owner/name` for `gh --repo`. */
export function toRepoSlug(repoUrlOrSlug: string): string {
  const s = repoUrlOrSlug.trim().replace(/\.git$/, "");
  const m = s.match(/github\.com[/:]([^/]+\/[^/]+)$/);
  if (m?.[1]) return m[1];
  if (/^[^/\s]+\/[^/\s]+$/.test(s)) return s; // already owner/name
  throw new Error(`Cannot derive owner/name from "${repoUrlOrSlug}"`);
}

/** Offline stub issue for --dry-run (no gh, no network). */
export function stubIssue(repoSlug: string, number: number): Issue {
  return { repo: toRepoSlug(repoSlug), number, title: "[dry-run] stub", body: "", url: "", state: "open", labels: [], author: "stub" };
}

/** List open issues of a repo (max 100), sorted ascending by number. Rejects on bad repo/auth. */
export async function listOpenIssues(repoUrlOrSlug: string): Promise<{ number: number; title: string }[]> {
  const repo = toRepoSlug(repoUrlOrSlug);
  const raw = await gh([
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--json",
    "number,title",
    "--limit",
    "100",
  ]);
  const j = JSON.parse(raw) as { number: number; title: string }[];
  const items = Array.isArray(j) ? j : [];
  return items.sort((a, b) => a.number - b.number);
}

/**
 * True when a repo already has an OPEN pull request for the given head branch,
 * null when gh succeeded and there is genuinely no open PR. Throws when the gh
 * command fails (auth/rate-limit/network) so callers can tell "no PR" apart
 * from "couldn't check".
 */
export async function hasOpenPrForBranch(repoUrlOrSlug: string, branch: string): Promise<boolean | null> {
  const repo = toRepoSlug(repoUrlOrSlug);
  const raw = await gh(["pr", "list", "--repo", repo, "--head", branch, "--state", "open", "--json", "number"]);
  const j = JSON.parse(raw);
  if (!Array.isArray(j)) {
    throw new Error(`gh pr list returned an unexpected payload: ${JSON.stringify(j).slice(0, 200)}`);
  }
  return j.length > 0 ? true : null;
}

/** Intake: fetch the issue via `gh issue view --json`. */
export async function fetchIssue(repoUrlOrSlug: string, number: number): Promise<Issue> {
  const repo = toRepoSlug(repoUrlOrSlug);
  const raw = await gh([
    "issue",
    "view",
    String(number),
    "--repo",
    repo,
    "--json",
    "number,title,body,url,state,labels,author",
  ]);
  const j = JSON.parse(raw);
  return {
    repo,
    number: j.number,
    title: j.title ?? "",
    body: j.body ?? "",
    url: j.url ?? "",
    state: j.state ?? "open",
    labels: Array.isArray(j.labels) ? j.labels.map((l: any) => l.name).filter(Boolean) : [],
    author: j.author?.login ?? "unknown",
  };
}

/** Issue lifecycle labels (0.1) — managed runs mark issues started / done via labels. */
export const ISSUE_LABEL_IN_PROGRESS = "multi-orch/in-progress";
export const ISSUE_LABEL_DONE = "multi-orch/done";

/** Split an `owner/name` slug (or any accepted repo URL) into its owner/repo parts. */
export function splitRepoSlug(repoUrlOrSlug: string): { owner: string; repo: string } {
  const slug = toRepoSlug(repoUrlOrSlug);
  const [owner, repo] = slug.split("/");
  return { owner: owner ?? "", repo: repo ?? "" };
}

/**
 * Run a `gh` command best-effort: any failure is swallowed with a warning so a
 * gh error can never abort a run (all lifecycle calls are non-fatal by design).
 */
async function ghBestEffort(args: string[], what: string): Promise<void> {
  try {
    await gh(args);
  } catch (e) {
    const err = e as Error & { stderr?: string };
    console.warn(`[gh] ${what} failed (non-fatal): ${err?.stderr?.trim() || err?.message || String(e)}`);
  }
}

/** Add a label to an issue. Never throws — a gh failure only warns. */
export async function addIssueLabel(
  owner: string,
  repo: string,
  issueNumber: number,
  label: string,
): Promise<void> {
  await ghBestEffort(
    ["issue", "edit", String(issueNumber), "--repo", `${owner}/${repo}`, "--add-label", label],
    `add label "${label}" to #${issueNumber}`,
  );
}

/** Remove a label from an issue. Never throws — a gh failure only warns. */
export async function removeIssueLabel(
  owner: string,
  repo: string,
  issueNumber: number,
  label: string,
): Promise<void> {
  await ghBestEffort(
    ["issue", "edit", String(issueNumber), "--repo", `${owner}/${repo}`, "--remove-label", label],
    `remove label "${label}" from #${issueNumber}`,
  );
}

/** True if the issue currently carries `label`. Returns false on any gh failure. */
export async function hasIssueLabel(
  owner: string,
  repo: string,
  issueNumber: number,
  label: string,
): Promise<boolean> {
  try {
    const raw = await gh(["issue", "view", String(issueNumber), "--repo", `${owner}/${repo}`, "--json", "labels"]);
    const j = JSON.parse(raw) as { labels?: { name?: string }[] };
    return Array.isArray(j.labels) && j.labels.some((l) => l.name === label);
  } catch {
    return false;
  }
}

/** Post a comment on an issue. Never throws — a gh failure only warns. */
export async function commentOnIssue(
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<void> {
  await ghBestEffort(
    ["issue", "comment", String(issueNumber), "--repo", `${owner}/${repo}`, "--body", body],
    `comment on #${issueNumber}`,
  );
}

/**
 * Best-effort creation of repo labels so `addIssueLabel` never hits a missing
 * label. Uses `--force` so an existing label is simply updated, not rejected.
 * Never throws — a gh failure only warns.
 */
export async function ensureLabels(owner: string, repo: string, labels: string[]): Promise<void> {
  for (const label of labels) {
    await ghBestEffort(
      ["label", "create", label, "--repo", `${owner}/${repo}`, "--force"],
      `create label "${label}"`,
    );
  }
}

export interface CreatePrResult {
  url: string;
  raw: string;
}

/**
 * Open a PR from `head` into `base`. Returns the PR URL. The PR worker normally does this
 * itself (it owns push+gh), but the orchestrator can call this as a fallback.
 */
export async function createPr(
  repoUrlOrSlug: string,
  opts: { head: string; base: string; title: string; body: string; cwd?: string },
): Promise<CreatePrResult> {
  const repo = toRepoSlug(repoUrlOrSlug);
  const out = await gh(
    [
      "pr",
      "create",
      "--repo",
      repo,
      "--base",
      opts.base,
      "--head",
      opts.head,
      "--title",
      opts.title,
      "--body",
      opts.body,
    ],
    opts.cwd,
  );
  const url = (out.match(/https?:\/\/\S+/) ?? [""])[0];
  return { url, raw: out.trim() };
}

export interface GhAuthInfo {
  ok: boolean;
  username?: string;
  error?: string;
}

/** Public OAuth app id used by the GitHub CLI. The device flow is unauthenticated. */
const GITHUB_CLIENT_ID = "178c6fc778ccc68e1d6a";
const DEVICE_SCOPES = "repo workflow read:org gist";

async function githubApi(url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text) as Record<string, unknown>;
  } catch {
    j = {};
  }
  if (!res.ok && j.error === undefined) {
    throw new Error(`GitHub API ${res.status}: ${text.slice(0, 200)}`);
  }
  return j;
}

export interface DeviceLoginRequest {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
}

/** Request a GitHub device-flow login. Returns the one-time code the user enters at verification_uri. */
export async function startDeviceLogin(): Promise<DeviceLoginRequest> {
  const j = await githubApi("https://github.com/login/device/code", {
    client_id: GITHUB_CLIENT_ID,
    scope: DEVICE_SCOPES,
  });
  if (!j.device_code) {
    throw new Error(String(j.error_description ?? "device login failed to start"));
  }
  return {
    deviceCode: String(j.device_code),
    userCode: String(j.user_code),
    verificationUri: String(j.verification_uri ?? "https://github.com/login/device"),
    interval: Number(j.interval) || 5,
  };
}

/**
 * Poll for the access token after `startDeviceLogin()`. Resolves with the token once the
 * user has authorized it; throws on denial/expiry/timeout.
 */
export async function pollDeviceToken(deviceCode: string, interval: number, timeoutMs = 10 * 60 * 1000): Promise<string> {
  const started = Date.now();
  let pollInterval = interval;
  while (Date.now() - started < timeoutMs) {
    await sleep(pollInterval * 1000);
    const j = await githubApi("https://github.com/login/oauth/access_token", {
      client_id: GITHUB_CLIENT_ID,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
    });
    if (j.access_token) return String(j.access_token);
    if (j.error === "authorization_pending") continue;
    if (j.error === "slow_down") {
      pollInterval += 5;
      continue;
    }
    if (j.error) {
      throw new Error(String(j.error_description ?? `device login failed: ${j.error}`));
    }
  }
  throw new Error("device login timed out");
}

/** Store an OAuth token via `gh auth login --with-token` (non-interactive). */
export async function storeGhToken(token: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("gh", ["auth", "login", "--with-token"], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (c) => {
      stderr += String(c);
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `gh auth login exited with code ${code}`));
    });
    child.stdin.on("error", () => {});
    child.stdin.write(token);
    child.stdin.end();
  });
}

/** Check gh auth (never throws). */
export async function ghAuthInfo(): Promise<GhAuthInfo> {
  try {
    const out = await gh(["api", "user", "--jq", ".login"]);
    const username = out.trim();
    if (!username) return { ok: false, error: "gh is not signed in — run `gh auth login`" };
    return { ok: true, username };
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { ok: false, error: "gh CLI not found on PATH" };
    }
    const err = e as Error & { stderr?: string };
    return { ok: false, error: err?.stderr?.trim() || err?.message || "gh is not signed in — run `gh auth login`" };
  }
}

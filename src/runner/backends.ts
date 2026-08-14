import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Backend, Role, RolePolicy, RunContext } from "../types.js";

export interface BackendDef {
  name: Backend;
  binary: string;
}

const BIN = {
  opencode: process.env.OPENCODE_BIN ?? "opencode",
  claude: process.env.CLAUDE_BIN ?? "claude",
  codex: process.env.CODEX_BIN ?? "codex",
} as const;

/** Resolve the binary + name for a backend (honors OPENCODE_BIN/CLAUDE_BIN/CODEX_BIN). */
export function backendDef(backend: Backend): BackendDef {
  return { name: backend, binary: BIN[backend] };
}

export interface BackendTrace {
  text: string;
  sessionID: string | null;
  tokens: { input: number; output: number; reasoning: number; cached: number; total: number };
  costUsd: number;
  sawError: boolean;
  errorMsg?: string;
}

const READ_ONLY_ROLES: readonly Role[] = ["analyzer", "planner", "reviewer"];
const MUTATE_ROLES: readonly Role[] = ["coder", "tester"];

function claudeMode(role: Role): string {
  return READ_ONLY_ROLES.includes(role) ? "plan" : "acceptEdits";
}

function codexSandbox(role: Role): string {
  if (role === "pr") return "danger-full-access";
  if (READ_ONLY_ROLES.includes(role)) return "read-only";
  return "workspace-write";
}

/** Read-only roles never get a mutate sandbox/mode; pr alone needs full network access. */

export interface BackendArgs {
  args: string[];
  cwd?: string;
}

export function buildBackendArgs(
  backend: Backend,
  role: Role,
  task: string,
  ctx: RunContext,
  model: string,
  policy: RolePolicy,
  opts: { variant?: RolePolicy["variant"] },
  rolePrompt: string,
): BackendArgs {
  switch (backend) {
    case "opencode": {
      const args = ["run", "--agent", role, "-m", model, "--dir", ctx.worktreeDir, "--format", "json"];
      const variant = opts.variant ?? policy.variant;
      if (variant) args.push("--variant", variant);
      args.push(task);
      return { args, cwd: ctx.rootDir };
    }
    case "claude": {
      const args = [
        "-p",
        task,
        "--output-format",
        "stream-json",
        "--model",
        model,
        "--append-system-prompt",
        rolePrompt,
        "--permission-mode",
        claudeMode(role),
      ];
      return { args, cwd: ctx.worktreeDir };
    }
    case "codex": {
      const sandbox = codexSandbox(role);
      const lastmsgPath = join(ctx.tracesDir, `${role}.lastmsg`);
      const args = ["exec", "--cd", ctx.worktreeDir, "-m", model, "-s", sandbox, "--json", "-o", lastmsgPath];
      if (MUTATE_ROLES.includes(role)) args.push("--approve-for-me");
      args.push("--", `${rolePrompt}\n\n${task}`);
      return { args, cwd: ctx.worktreeDir };
    }
  }
}

/** Per-run env. Every backend gets SOR_EVENT_DIR (the hook scripts/plugin write events.jsonl there);
 *  opencode additionally gets an isolated data dir + seeded auth; claude/codex inherit the shell. */
export function buildBackendEnv(backend: Backend, ctx: RunContext): NodeJS.ProcessEnv {
  const sorEventDir = join(ctx.runDir, "events");
  try {
    mkdirSync(sorEventDir, { recursive: true });
  } catch {
    // non-fatal: the hook scripts/plugin create it lazily if needed
  }
  const base: NodeJS.ProcessEnv = { ...process.env, SOR_EVENT_DIR: sorEventDir };
  if (backend !== "opencode") return base;
  const dataHome = join(ctx.runDir, ".opencode-data");
  try {
    mkdirSync(join(dataHome, "opencode"), { recursive: true });
    copyFileSync(
      join(homedir(), ".local", "share", "opencode", "auth.json"),
      join(dataHome, "opencode", "auth.json"),
    );
  } catch {
    // non-fatal: continue without a seeded auth file
  }
  return {
    ...base,
    OPENCODE_CONFIG: join(ctx.rootDir, "opencode.json"),
    XDG_DATA_HOME: dataHome,
  };
}

/** Role prompt for claude/codex (agents/<role>.md with YAML frontmatter stripped). Empty for opencode. */
export function resolveRolePrompt(backend: Backend, role: Role, ctx: RunContext): string {
  if (backend === "opencode") return "";
  let content: string;
  try {
    content = readFileSync(join(ctx.rootDir, "agents", `${role}.md`), "utf8");
  } catch {
    return "";
  }
  const lines = content.split("\n");
  let first = -1;
  let second = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() === "---") {
      if (first === -1) first = i;
      else {
        second = i;
        break;
      }
    }
  }
  if (first === -1 || second === -1) return content;
  return lines.slice(second + 1).join("\n");
}

/** Parse a trace body into a normalized shape. `opts.lastmsgPath` is the codex `-o` fallback file. */
export function parseBackendTrace(
  backend: Backend,
  rawBody: string,
  startOffset: number,
  opts: { lastmsgPath?: string } = {},
): BackendTrace {
  const body = startOffset > 0 ? rawBody.slice(startOffset) : rawBody;
  const acc: BackendTrace = emptyTrace();
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue; // non-JSON noise that leaked into the trace
    }
    parseBackendLine(backend, ev, acc);
  }
  if (backend === "codex" && acc.text.trim().length === 0 && opts.lastmsgPath) {
    try {
      const fallback = readFileSync(opts.lastmsgPath, "utf8").trim();
      if (fallback) acc.text = fallback;
    } catch {
      // no -o file written; keep stdout result
    }
  }
  return acc;
}

/** Dispatch one trace line to the backend's line parser. */
export function parseBackendLine(backend: Backend, ev: any, acc: BackendTrace): void {
  switch (backend) {
    case "opencode":
      parseOpencodeLine(ev, acc);
      break;
    case "claude":
      parseClaudeLine(ev, acc);
      break;
    case "codex":
      parseCodexLine(ev, acc);
      break;
  }
}

function parseOpencodeLine(ev: any, acc: BackendTrace): void {
  if (ev.sessionID && !acc.sessionID) acc.sessionID = ev.sessionID;
  const part = ev.part ?? {};
  if (ev.type === "text" && typeof part.text === "string") {
    acc.text += part.text;
  } else if (ev.type === "step_finish") {
    if (part.tokens) {
      acc.tokens.input += part.tokens.input ?? 0;
      acc.tokens.output += part.tokens.output ?? 0;
      acc.tokens.reasoning += part.tokens.reasoning ?? 0;
      acc.tokens.cached += part.tokens.cache?.read ?? part.tokens.cacheRead ?? 0;
      acc.tokens.total = acc.tokens.input + acc.tokens.output + acc.tokens.reasoning;
    }
    acc.costUsd += part.cost ?? 0;
  } else if (ev.type === "error" || part.type === "error") {
    acc.sawError = true;
    acc.errorMsg = part.error ?? ev.error ?? "opencode error event";
  }
}

function parseClaudeLine(ev: any, acc: BackendTrace): void {
  if (ev.type === "system" && ev.subtype === "init") {
    if (ev.session_id) acc.sessionID = ev.session_id;
  } else if (ev.type === "assistant") {
    const content = ev.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block?.text === "string") acc.text += block.text;
      }
    }
  } else if (ev.type === "result") {
    if (typeof ev.result === "string") acc.text = ev.result;
    if (ev.is_error) {
      acc.sawError = true;
      acc.errorMsg = ev.error ?? ev.message ?? "claude result error";
    }
    if (typeof ev.total_cost_usd === "number") acc.costUsd = ev.total_cost_usd;
    const usage = ev.usage;
    if (usage) {
      acc.tokens.input += usage.input_tokens ?? 0;
      acc.tokens.output += usage.output_tokens ?? 0;
      acc.tokens.reasoning += usage.reasoning_tokens ?? 0;
      acc.tokens.cached += (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
      acc.tokens.total = acc.tokens.input + acc.tokens.output + acc.tokens.reasoning;
    }
    if (ev.session_id) acc.sessionID = ev.session_id;
  }
}

function parseCodexLine(ev: any, acc: BackendTrace): void {
  if (ev.type === "message" || ev.type === "assistant") {
    let text = "";
    if (typeof ev.text === "string") text = ev.text;
    else if (Array.isArray(ev.message?.content)) {
      text = ev.message.content
        .map((c: any) => (typeof c === "string" ? c : typeof c?.text === "string" ? c.text : ""))
        .join("");
    }
    if (text) acc.text += text;
  }
  if (ev.type === "error") {
    acc.sawError = true;
    acc.errorMsg = ev.error ?? ev.message ?? "codex error";
  }
  if (ev.type === "result" || ev.type === "final" || ev.type === "response") {
    const out =
      typeof ev.result === "string" ? ev.result : typeof ev.output === "string" ? ev.output : ev.text;
    if (typeof out === "string" && out) acc.text += out;
    if (ev.status === "error" || ev.status === "failed" || ev.is_error) {
      acc.sawError = true;
      acc.errorMsg = ev.error ?? ev.message ?? ev.reason ?? "codex error";
    }
    if (ev.usage) {
      acc.tokens.input += ev.usage.input_tokens ?? ev.usage.prompt_tokens ?? 0;
      acc.tokens.output += ev.usage.output_tokens ?? ev.usage.completion_tokens ?? 0;
      acc.tokens.reasoning += ev.usage.reasoning_tokens ?? 0;
      acc.tokens.cached +=
        ev.usage.prompt_tokens_details?.cached_tokens ??
        ev.usage.input_tokens_details?.cached_tokens ??
        ev.usage.cached_tokens ??
        0;
      acc.tokens.total = acc.tokens.input + acc.tokens.output + acc.tokens.reasoning;
    }
    if (ev.session_id || ev.sessionId) acc.sessionID = ev.session_id ?? ev.sessionId;
  }
}

const emptyTrace = (): BackendTrace => ({
  text: "",
  sessionID: null,
  tokens: { input: 0, output: 0, reasoning: 0, cached: 0, total: 0 },
  costUsd: 0,
  sawError: false,
});

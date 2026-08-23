import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";

interface GhApiResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runGhApi(args: string[]): Promise<GhApiResult> {
  return new Promise(async (resolve) => {
    const proc = Bun.spawn(["gh", "api", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdoutChunks: Uint8Array[] = [];
    const stderrChunks: Uint8Array[] = [];
    for await (const chunk of proc.stdout) stdoutChunks.push(chunk);
    for await (const chunk of proc.stderr) stderrChunks.push(chunk);
    const exitCode = await proc.exited;
    resolve({
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
      exitCode,
    });
  });
}

function reqString(
  args: Record<string, unknown>,
  key: string,
  tool: string
): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Tool ${tool}: missing or invalid string argument '${key}'`);
  }
  return value;
}

function reqNumber(
  args: Record<string, unknown>,
  key: string,
  tool: string
): number {
  const value = args[key];
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`Tool ${tool}: missing or invalid number argument '${key}'`);
  }
  return value;
}

const ALLOWED_TOOLS_PER_ROLE: Record<string, string[]> = {
  analyzer: ["get_issue", "get_issue_comments"],
  pr: ["create_pr", "get_checks"],
};

function isToolAllowedForRole(role: string, toolName: string): boolean {
  const allowed = ALLOWED_TOOLS_PER_ROLE[role];
  if (!allowed) return false;
  return allowed.includes(toolName);
}

const server = new Server(
  { name: "fleet-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

const GET_ISSUE_SCHEMA = {
  type: "object",
  properties: {
    owner: { type: "string" },
    repo: { type: "string" },
    number: { type: "number" },
  },
  required: ["owner", "repo", "number"],
} as const;

const GET_ISSUE_COMMENTS_SCHEMA = {
  type: "object",
  properties: {
    owner: { type: "string" },
    repo: { type: "string" },
    number: { type: "number" },
  },
  required: ["owner", "repo", "number"],
} as const;

const CREATE_PR_SCHEMA = {
  type: "object",
  properties: {
    owner: { type: "string" },
    repo: { type: "string" },
    head: { type: "string" },
    base: { type: "string" },
    title: { type: "string" },
    body: { type: "string" },
  },
  required: ["owner", "repo", "head", "base", "title", "body"],
} as const;

const GET_CHECKS_SCHEMA = {
  type: "object",
  properties: {
    owner: { type: "string" },
    repo: { type: "string" },
    ref: { type: "string" },
  },
  required: ["owner", "repo", "ref"],
} as const;

async function handleGetIssue(args: Record<string, unknown>): Promise<unknown> {
  const owner = reqString(args, "owner", "get_issue");
  const repo = reqString(args, "repo", "get_issue");
  const number = reqNumber(args, "number", "get_issue");

  const result = await runGhApi(["--method", "GET", `/repos/${owner}/${repo}/issues/${number}`]);
  if (result.exitCode !== 0) {
    throw new Error(`gh api failed: ${result.stderr}`);
  }
  const issue = JSON.parse(result.stdout);
  return {
    title: issue.title,
    body: issue.body ?? "",
    labels: (issue.labels ?? []).map((l: { name: string }) => l.name),
  };
}

async function handleGetIssueComments(args: Record<string, unknown>): Promise<unknown> {
  const owner = reqString(args, "owner", "get_issue_comments");
  const repo = reqString(args, "repo", "get_issue_comments");
  const number = reqNumber(args, "number", "get_issue_comments");

  const result = await runGhApi(["--method", "GET", `/repos/${owner}/${repo}/issues/${number}/comments`]);
  if (result.exitCode !== 0) {
    throw new Error(`gh api failed: ${result.stderr}`);
  }
  const comments = JSON.parse(result.stdout);
  return comments.map((c: { user: { login: string }; body: string; created_at: string }) => ({
    author: c.user.login,
    body: c.body,
    createdAt: c.created_at,
  }));
}

async function handleCreatePr(args: Record<string, unknown>): Promise<unknown> {
  const owner = reqString(args, "owner", "create_pr");
  const repo = reqString(args, "repo", "create_pr");
  const head = reqString(args, "head", "create_pr");
  const base = reqString(args, "base", "create_pr");
  const title = reqString(args, "title", "create_pr");
  const body = reqString(args, "body", "create_pr");

  const result = await runGhApi([
    "--method", "POST",
    `/repos/${owner}/${repo}/pulls`,
    "-f", `head=${head}`,
    "-f", `base=${base}`,
    "-f", `title=${title}`,
    "-f", `body=${body}`,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`gh api failed: ${result.stderr}`);
  }
  const pr = JSON.parse(result.stdout);
  return { url: pr.html_url, number: pr.number };
}

async function handleGetChecks(args: Record<string, unknown>): Promise<unknown> {
  const owner = reqString(args, "owner", "get_checks");
  const repo = reqString(args, "repo", "get_checks");
  const ref = reqString(args, "ref", "get_checks");

  const result = await runGhApi(["--method", "GET", `/repos/${owner}/${repo}/commits/${ref}/check-runs`]);
  if (result.exitCode !== 0) {
    throw new Error(`gh api failed: ${result.stderr}`);
  }
  const data = JSON.parse(result.stdout);
  return data.check_runs?.map((run: { name: string; conclusion: string | null; status: string; html_url: string }) => ({
    name: run.name,
    conclusion: run.conclusion,
    status: run.status,
    url: run.html_url,
  })) ?? [];
}

async function handleToolCall(name: string, args: Record<string, unknown>, role?: string): Promise<unknown> {
  if (role && !isToolAllowedForRole(role, name)) {
    throw new Error(`Tool ${name} not allowed for role ${role}`);
  }

  switch (name) {
    case "get_issue":
      return handleGetIssue(args);
    case "get_issue_comments":
      return handleGetIssueComments(args);
    case "create_pr":
      return handleCreatePr(args);
    case "get_checks":
      return handleGetChecks(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

server.setRequestHandler(ListToolsRequestSchema, async (request) => {
  const role = (request.params as { _meta?: { role?: string } })._meta?.role;
  const allTools = [
    { name: "get_issue", description: "Get issue title, body, and labels", inputSchema: GET_ISSUE_SCHEMA },
    { name: "get_issue_comments", description: "Get issue comments", inputSchema: GET_ISSUE_COMMENTS_SCHEMA },
    { name: "create_pr", description: "Create a pull request", inputSchema: CREATE_PR_SCHEMA },
    { name: "get_checks", description: "Get check runs for a commit ref", inputSchema: GET_CHECKS_SCHEMA },
  ];

  const filtered = role ? allTools.filter((t) => isToolAllowedForRole(role, t.name)) : allTools;
  return { tools: filtered };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const role = (request.params as { _meta?: { role?: string } })._meta?.role;

  try {
    const result = await handleToolCall(name, args ?? {}, role);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ error: msg }, null, 2) }],
    };
  }
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await server.close().catch(() => {});
}

async function main(role?: string): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

process.stdin.on("end", () => {
  void shutdown();
});
process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});

export { handleToolCall, isToolAllowedForRole, ALLOWED_TOOLS_PER_ROLE };

const isEntry = process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href;
if (isEntry) {
  const role = process.argv[2];
  void main(role).catch(() => process.exit(1));
}
---
title: Security — Fleet security model and dependency posture
status: active
date: 2026-10-16
owner: ain
audience: contributors, reviewers, and automation reading a scanner report
---

# Security

This document records Fleet's security model, its trust boundaries, and the standing answers to
dependency-scanner findings. It exists so that a `npm audit` / M8ven / Dependabot alert can be
adjudicated from a lookup rather than a fresh investigation.

It is **not** a vulnerability disclosure page. Fleet has had no reported security incident.

---

## 1. Threat model in one paragraph

Fleet is an autonomous agent system: it reads a GitHub issue (and its comments, and later PR
comments and repo file contents), plans, writes code, runs it, and opens a real pull request. The
**untrusted input** is that GitHub-authored text. The **high-consequence capability** is that a
model it talks to can execute shell commands and write to a real repository. Any untrusted text
that reaches a model's context is therefore in scope for prompt injection.

The **developer machine** is also in scope: workers run commands on the host where Fleet runs.

## 2. Trust boundaries

| Boundary | Enforcement | Location |
|---|---|---|
| Worker ↔ host filesystem | worktree-scoped cwd; lexical + `realpath` path guards | `src/fleet/tools/common.ts` (`resolveInside`, `resolveExistingInside`) |
| Worker ↔ shell | per-role toolset allowlist | `src/fleet/policyEval.ts`, `src/fleet/policy.ts` |
| MCP tool ↔ role | hardcoded per-role allowlist, fail-closed | `src/mcp/fleetServer.ts` (`ALLOWED_TOOLS_PER_ROLE`, `isToolAllowedForRole`) |
| Manager ↔ model providers | no model calls outside worker child processes | `src/agentRunner.ts` |
| Git write access | only the `pr` role; `create_pr` / `get_checks` | `src/mcp/fleetServer.ts` |
| Audit integrity | append-only DB trigger + hash chain | `src/sor/`, `migrations/` |

### The bash tool is a real shell — `cwd` is pinned, but this is **not** a sandbox

`src/fleet/tools/bash.ts` runs model-supplied strings with `spawn(command, [], { shell: true })`.

Honest characterisation, because it is easy to overstate in either direction:

- `cwd` is pinned inside the worker worktree, so commands **start** in the right place.
- That does **not** confine the process. `cd /etc && cat passwd` starts inside the worktree and
  leaves it. There is no container, seccomp, or namespace isolation.
- This is **by design**. Fleet's purpose is to let an agent run commands; `AGENTS.md` lists
  "bash worktree cwd-locking" as a boundary to *preserve*, which confirms the lock is a guard
  within an intentionally powerful tool.
- Mitigations that do exist: per-role gating, 20,000-char output cap, timeout with
  process-group kill (`detached: true` + `kill(-pid)`), and a disposable git worktree.

Treat worker shell execution as **full host-level code execution scoped by role, not by
filesystem**. Anything that would change that (tighter gating, cwd-locking changes) is a
`AGENTS.md` "Never weaken" boundary and needs owner sign-off.

### Known open question

**Prompt injection** — whether untrusted issue/PR text can steer the analyzer/coder/reviewer
models into invoking `bash`, `create_pr`, or git operations they otherwise would not — is
**not yet formally threat-modelled**. Tracked as an open item in `specs/core/SPEC.md` §17.

## 3. MCP posture: stdio only, no OAuth

This is the standing answer to MCP-scanner findings.

Fleet is **both** an MCP server and an MCP client, and it is **stdio-only in both roles**.

| Role | File | Transport | Remote peers |
|---|---|---|---|
| Server (run/SOR bookkeeping) | `src/mcp/server.ts` | `StdioServerTransport` | none |
| Server (GitHub, role-gated) | `src/mcp/fleetServer.ts` | `StdioServerTransport` | none |
| Server (Content SoR, read-only) | `src/mcp/contentTools.ts` | tool definitions only | none |
| Client | `src/fleet/tools/mcp.ts` | `StdioClientTransport` | none |

The client's peer is a **hardcoded local command** — `tsx src/mcp/fleetServer.ts <role>` — Fleet's
own server. There is no configuration, environment variable, or runtime path by which a remote MCP
server can be introduced.

The complete set of SDK entry points imported anywhere in `src/` is:

```
@modelcontextprotocol/sdk/client/index.js
@modelcontextprotocol/sdk/client/stdio.js
@modelcontextprotocol/sdk/server/index.js
@modelcontextprotocol/sdk/server/stdio.js
@modelcontextprotocol/sdk/types.js
```

There is **no** HTTP/SSE transport import and **no** OAuth import. Fleet never constructs an
`authProvider`, never calls `withOAuth()`, `auth()`, or `fetchToken()`, constructs none of the
bundled providers (`ClientCredentialsProvider`, `PrivateKeyJwtProvider`,
`StaticPrivateKeyJwtProvider`, `CrossAppAccessProvider`), and holds **no** MCP OAuth credentials
or persisted token store.

> The `src/github/gh.ts` OAuth references are **GitHub CLI device-flow**, called directly against
> `https://github.com/login/oauth/access_token`. They have nothing to do with the MCP SDK and are
> not a match for MCP OAuth advisories.

### GHSA-6qxp-vccf-f47h / CVE-2026-104850 — why it does not apply

- **Package:** `@modelcontextprotocol/sdk`
- **Affected:** `>=1.12.0, <1.31.0` · **Patched:** `1.31.0` · **Severity:** High (CVSS 7.5)
- **Flaw:** the SDK's OAuth **client** did not bind stored credentials to the issuing authorization
  server, so a malicious MCP server could name its own authorization server and be handed the
  `refresh_token` / `client_secret` with no user interaction (CWE-345, CWE-522).

The advisory states **"Not affected: MCP servers built with the SDK, stdio clients."** Fleet is
both of those. Its own "Am I affected?" test also requires an OAuth client **over HTTP**; Fleet has
neither an OAuth client nor an HTTP transport.

**Conclusion: not applicable to Fleet.** Verified against the advisory text, the import graph, and
the installed SDK's own `stdio.js` entry points (which import only `node:process`,
`node:stream`, `cross-spawn`, and the SDK's shared stdio helper — never `express`, `hono`, or any
OAuth module).

**Standing rule:** MCP advisories scoped to the OAuth client, HTTP/SSE transports, or
authorization-server handling do not apply unless Fleet's MCP surface changes. If you ever add an
HTTP MCP transport, an `authProvider`, or `withOAuth()`, this exemption is void — re-audit.

## 4. Dependency posture

As of the S2 lockfile refresh, `npm audit --omit=dev` reports **1 production advisory**: the
`@modelcontextprotocol/sdk` OAuth advisory in §3, which does not apply to Fleet. It previously
reported 6.

The other 5 were **stale lockfile pins** inside semver ranges Fleet already declared, and S2
cleared them with no code change:

| Package | Before | After |
|---|---|---|
| `proxy-addr` (was critical) | 2.0.7 | 2.0.8 |
| `fast-uri` | 3.1.5 | 3.1.8 |
| `hono` | 4.13.1 | 4.13.13 |
| `ip-address` | 10.5.0 | 10.7.4 |
| `qs` | 6.15.3 | 6.16.1 |

All 5 were reachable only as declared runtime dependencies of `@modelcontextprotocol/sdk`, which
declares `express`, `express-rate-limit`, `hono`, `@hono/node-server`, `ajv`, `cors`,
`eventsource`, `jose`, `pkce-challenge` regardless of which entry points are imported. Under the
stdio-only architecture the HTTP/OAuth modules are never imported.

**Residual surface, not currently flagged:** `ajv` is still instantiated on every MCP server
(`server/index.js` defaults `jsonSchemaValidator` to `AjvJsonSchemaValidator`), so the parser
reachable via `fast-uri` remains live in-process. No Fleet tool schema uses a `format: "uri"`
keyword, so the affected path is not exercised. Clearing the advisory did not remove that code
path — it only removed the known-vulnerable version from the lockfile.

Development-only advisories (`vitest`, `tinypool`, `source-map-js`, `brace-expansion`, `js-yaml`,
`argparse`, `sprintf-js`, `@vitest/*`) are **not** production dependencies. They do not ship; they
run in CI, which commonly holds repository secrets, so they are still worth keeping current.

Known issue, and the reason S2 and S3 are separate commits: bumping the MCP SDK does **not** clear
the transitive set on its own — `@modelcontextprotocol/sdk@1.32.1` declares byte-identical
dependency ranges to `@1.30.0`. The lockfile refresh is what moved those pins; the S3 floor bump
only raises the SDK. Conversely, S2 alone leaves the SDK advisory open, and S3 alone is dependency
hygiene for a code path Fleet does not use.

## 5. Reporting a vulnerability

Open a **private** security advisory on the repository rather than a public issue. Please include
reproduction steps, the affected commit, and whether the finding involves worker shell execution,
MCP tool gating, or the audit chain (`src/sor/`).

## 6. Explicitly **not** security findings

Recorded here so these are not re-litigated each scan.

| Report item | Reality |
|---|---|
| **Missing MCP tool annotations** | Optional, advisory **metadata**. Fleet enforces authorization in **code** (`isToolAllowedForRole`, `policyEval.allowedTools`); a model cannot gain a capability by ignoring a missing hint. Quality/UX item. |
| **Shell/`exec` call sites** | Shell use is not per se unsafe. All non-bash call sites use **argv arrays**, so agent-supplied strings (issue titles, PR bodies, refs) cannot become shell syntax. The single `shell: true` is the intentional, role-gated, worktree-cwd-pinned bash tool. |
| **No `LICENSE` file** | Legal/metadata. Practical effect is default "all rights reserved" — *more* restrictive, not a security exposure. |
| **Publisher reputation** | A statement about the maintainer account, not the code. No code action. |
| **No credential exfiltration / no obfuscation / source-code verification** | M8ven's own **passing** checks. Not defects. |

## 7. Secrets

- Secrets live **only** in `.env`, which is gitignored (`.env.*` ignored, `.env.example`
  excepted). Add new variables to `.env.example` per `AGENTS.md`.
- Workers never `git push`. The `pr` role creates PRs but never merges.
- GitHub access goes through the `gh` CLI's own credential store; the token is piped to
  `gh auth login --with-token` over **stdin**, never interpolated into a command line.
- SOR writes are non-fatal by design: warn and continue, never abort a run over an audit failure.

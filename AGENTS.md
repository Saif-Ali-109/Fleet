# Multi-Orchestration

TypeScript Manager driving 6 headless `opencode` workers to take a GitHub issue to a real PR, gated by 3 human approvals.

## Stack

Node ≥22, TypeScript, `tsx`, `vitest`. Dashboard = hand-rolled `node:http`.

## Commands

- `npm start -- --repo <url> --issue <n>` — one issue → PR
- `npm run dry` — no tokens/API calls, stubs workers
- `npm run build:config` / `npm run check:config` — regenerate / verify generated configs from `agents/*.md`
- `npm test` — vitest
- `npm run sor:verify` — replay SOR hash chain
- `npm run sor:sync-registry` — refresh `agent_registry` from `agents/*.md`

## Code Style

- Plain TypeScript in `src/*` — **never add model calls** to `orchestrator.ts`; only spawned workers call models
- Per-tool fields (`codex_model`, `claude_model`, etc.) are opt-in; never infer one provider's model ID from another
- Edit `agents/<role>.md`, run `npm run build:config`, commit both — never hand-edit generated configs (`.fleet/**`, incl. `.fleet/opencode.json`, `.fleet/claude/agents/*.md`, `.fleet/codex/agents/*.toml`)
- Workers run in isolated git worktrees; never touch files outside assigned worktree

## Security

- `gh` auth required for real PRs; `--dry-run` stubs every worker
- `SOR_SIGNING_KEY` required (`openssl rand -hex 32`) for tamper-evident audit log
- All SOR writes are non-fatal — never abort a run
- coder/tester must never `git push`; pr must never merge (prompt-enforced, not permission-enforced)

## Architecture

- `src/orchestrator.ts` — Manager: routing, 3 gates, git worktrees
- `src/agentRunner.ts` — spawns headless `opencode run` workers, parses NDJSON
- `src/models/modelPolicy.ts` — authoritative model tiers + fallback pool; overrides `.fleet/opencode.json`'s model at spawn via `-m`
- `agents/<role>.md` — single canonical source for every fleet role; frontmatter = config, body = prompt verbatim
- `scripts/generate-configs.ts` — runs adapters in `scripts/adapters/` against `agents/*.md` → each tool's native format
- PostgreSQL 16 backed; `DATABASE_URL` set, schema migrated (`npm run migrate:up`)

## Boundaries

### Always

- Run `npm run build:config` after editing any `agents/*.md`
- Commit both source (`agents/*.md`) and generated configs together
- Use `npm run check:config` in CI to fail on drift
- Workers receive `-m <model>` override at spawn from `modelPolicy.ts`

### Ask First

- Adding new agent roles (requires `agents/<role>.md` + adapter registration)
- Changing SOR event types or hash chain logic
- Modifying the 3-gate approval flow in `orchestrator.ts`

### Never

- Hand-edit `.fleet/**` or any generated config (`.fleet/opencode.json`, `.fleet/claude/agents/*.md`, `.fleet/codex/agents/*.toml`)
- Add model calls to `src/orchestrator.ts` or any `src/*` manager code
- Have coder/tester workers `git push` or pr worker `merge`
- Assume `--dry-run` exercises real worker spawns
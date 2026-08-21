/**
 * Shared hook-script templates for the signed System of Record (SOR).
 *
 * Per-tool hooks (claude / codex) append one compact JSON line to
 * $SOR_EVENT_DIR/events.jsonl. The adapters in scripts/adapters/ use these
 * builders to emit each tool's native hook config; every function here is a
 * pure, deterministic template so generated configs stay byte-stable for
 * `check:config` drift detection.
 */

const CLAUDE_HOOK_COMMAND = 'bash "$FLEET_SOR_HOOK"';
const CLAUDE_HOOK_EVENTS = ["PreToolUse", "PostToolUse", "SessionStart", "Stop"] as const;

/**
 * Emits the JSON value for the `hooks` member of the generated Claude settings
 * JSON (.fleet/claude/settings.json).
 *
 * Each event name (PascalCase, per Claude Code docs) maps to an array of
 * matcher groups; each group is `{ "matcher": "*", "hooks": [{ "type":
 * "command", "command": "bash \"$FLEET_SOR_HOOK\"" }] }`. The hook command is
 * env-var indirection: FLEET_SOR_HOOK (set by the Manager in
 * src/runner/backends.ts per worker at spawn) points at the sor-hook.sh
 * script, making hooks cwd- and location-independent. The returned string is
 * the map to place under the top-level "hooks" key.
 */
export function emitClaudeSettingsHooks(): string {
  const hooks: Record<string, unknown> = Object.fromEntries(
    CLAUDE_HOOK_EVENTS.map((event) => [
      event,
      [{ matcher: "*", hooks: [{ type: "command", command: CLAUDE_HOOK_COMMAND }] }],
    ]),
  );
  return JSON.stringify(hooks, null, 2);
}

const CODEX_HOOK_EVENTS = ["PreToolUse", "PostToolUse"] as const;
const CODEX_HOOK_COMMAND = 'bash "$FLEET_SOR_HOOK"';

/**
 * Emits the TOML hook section + feature flag for the generated Codex config
 * (.fleet/codex/config.toml):
 *
 *   [hooks]
 *   [[hooks.PreToolUse]]  [[hooks.PreToolUse.hooks]]  type/command ...
 *   [[hooks.PostToolUse]] [[hooks.PostToolUse.hooks]] type/command ...
 *   [features]
 *   codex_hooks = true
 *
 * Follows the OpenAI Codex inline-hooks schema: `[[hooks.<Event>]]` is a
 * matcher group and `[[hooks.<Event>.hooks]]` is a command handler. The hook
 * command uses FLEET_SOR_HOOK (set by the Manager in src/runner/backends.ts
 * per worker at spawn) so it is cwd- and location-independent.
 */
export function emitCodexConfigHooks(): string {
  const group = (event: string): string =>
    [
      `[[hooks.${event}]]`,
      `[[hooks.${event}.hooks]]`,
      'type = "command"',
      `command = ${JSON.stringify(CODEX_HOOK_COMMAND)}`,
    ].join("\n");

  return [
    "[hooks]",
    group("PreToolUse"),
    group("PostToolUse"),
    "",
    "[features]",
    "codex_hooks = true",
    "",
  ].join("\n");
}

/**
 * Deep-sorts object keys (recursively) so JSON.stringify emits a canonical,
 * stable ordering regardless of insertion order.
 */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Returns a single-line, key-sorted JSON string of the event payload a hook
 * script appends to $SOR_EVENT_DIR/events.jsonl.
 *
 * Reads SOR_EVENT_TYPE (default "tool_call"), SOR_ACTOR (default "system"),
 * SOR_BACKEND (default "") and SOR_RUN_ID (default "") from the environment,
 * then merges `extra` on top (extra wins). Always includes event_type, actor,
 * backend, payload (object), run_id and created_at (ISO now).
 */
export function buildHookEventJson(extra: Record<string, unknown>): string {
  const event: Record<string, unknown> = {
    event_type: process.env.SOR_EVENT_TYPE ?? "tool_call",
    actor: process.env.SOR_ACTOR ?? "system",
    backend: process.env.SOR_BACKEND ?? "",
    run_id: process.env.SOR_RUN_ID ?? "",
    payload: {},
    created_at: new Date().toISOString(),
    ...extra,
  };
  return JSON.stringify(sortKeys(event));
}

/**
 * POSIX-sh hook script written by the Claude Code and Codex adapters to
 * `.fleet/claude/hooks/sor-hook.sh` / `.fleet/codex/hooks/sor-hook.sh`.
 * Generated hook configs invoke it via `bash "$FLEET_SOR_HOOK"` (env var set
 * by the Manager in src/runner/backends.ts), so the script's on-disk location
 * is decoupled from the config content.
 *
 * Reads SOR_EVENT_DIR/SOR_EVENT_TYPE/SOR_ACTOR/SOR_BACKEND/SOR_RUN_ID from the
 * environment and appends one key-sorted, single-line JSON record (same shape
 * as buildHookEventJson) to $SOR_EVENT_DIR/events.jsonl in append mode. No-ops
 * with exit 0 when SOR_EVENT_DIR is unset or empty. Byte-stable so the
 * adapters can emit it as a generated file for `check:config` drift detection.
 */
export function emitSorHookScript(): string {
  return `#!/usr/bin/env bash
set -u

sor_dir="\${SOR_EVENT_DIR:-}"
if [ -z "$sor_dir" ]; then
  exit 0
fi

json_escape() {
  printf '%s' "$1" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g'
}

created_at="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
event_type="\${SOR_EVENT_TYPE:-tool_call}"
actor="\${SOR_ACTOR:-system}"
backend="\${SOR_BACKEND:-}"
run_id="\${SOR_RUN_ID:-}"

# claude/codex pass the tool-call payload on stdin; grab the tool name there
# (fall back to SOR_TOOL_NAME env). Input/output are intentionally NOT
# embedded (may contain arbitrary nesting); the Manager captures those from
# the tool's own trace when available.
stdin="$(cat 2>/dev/null || true)"
  tool_name=""
  case "$stdin" in
    *"tool_name"*) tool_name="$(printf '%s' "$stdin" | grep -o '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n1 | cut -d '"' -f 4)" ;;
  esac
tool_name="\${SOR_TOOL_NAME:-\$tool_name}"

mkdir -p "$sor_dir"
printf '{"actor":"%s","backend":"%s","created_at":"%s","event_type":"%s","payload":{},"run_id":"%s","tool_name":"%s"}\\n' "$(json_escape "$actor")" "$(json_escape "$backend")" "$created_at" "$(json_escape "$event_type")" "$(json_escape "$run_id")" "$(json_escape "$tool_name")" >> "$sor_dir/events.jsonl"
`;
}
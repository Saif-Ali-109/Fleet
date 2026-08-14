#!/usr/bin/env bash
set -u

sor_dir="${SOR_EVENT_DIR:-}"
if [ -z "$sor_dir" ]; then
  exit 0
fi

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

created_at="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
event_type="${SOR_EVENT_TYPE:-tool_call}"
actor="${SOR_ACTOR:-system}"
backend="${SOR_BACKEND:-}"
run_id="${SOR_RUN_ID:-}"

# claude/codex pass the tool-call payload on stdin; grab the tool name there
# (fall back to SOR_TOOL_NAME env). Input/output are intentionally NOT
# embedded (may contain arbitrary nesting); the Manager captures those from
# the tool's own trace when available.
stdin="$(cat 2>/dev/null || true)"
  tool_name=""
  case "$stdin" in
    *"tool_name"*) tool_name="$(printf '%s' "$stdin" | grep -o '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n1 | cut -d '"' -f 4)" ;;
  esac
tool_name="${SOR_TOOL_NAME:-$tool_name}"

mkdir -p "$sor_dir"
printf '{"actor":"%s","backend":"%s","created_at":"%s","event_type":"%s","payload":{},"run_id":"%s","tool_name":"%s"}\n' "$(json_escape "$actor")" "$(json_escape "$backend")" "$created_at" "$(json_escape "$event_type")" "$(json_escape "$run_id")" "$(json_escape "$tool_name")" >> "$sor_dir/events.jsonl"

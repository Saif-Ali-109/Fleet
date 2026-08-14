/**
 * System of Record (SOR) hook plugin for opencode.
 *
 * COMMITTED SOURCE — never generated, never edited by build:config. Referenced
 * from the generated opencode.json `plugin` array as `.opencode/plugins/sor-hook.ts`
 * (relative to the config file), so workers spawned in foreign git worktrees
 * via OPENCODE_CONFIG still load it.
 *
 * Each hook appends one key-sorted, single-line JSON record to
 * $SOR_EVENT_DIR/events.jsonl (same shape as scripts/lib/hooks.ts
 * buildHookEventJson). No-ops when SOR_EVENT_DIR is unset or empty.
 *
 * Hook names below are taken verbatim from the installed
 * @opencode-ai/plugin@1.18.7 `Hooks` interface (.opencode/node_modules/
 * @opencode-ai/plugin/dist/index.d.ts): "tool.execute.before",
 * "tool.execute.after" and "event". There is no `session.created` hook in
 * that version — session creation is observed through the SDK `event` hook
 * (`event.type === "session.created"`).
 */

import type { Plugin } from "@opencode-ai/plugin";
import type { Event } from "@opencode-ai/sdk";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

/** Deep-sorts object keys so JSON.stringify emits a canonical ordering. */
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

async function writeEvent(eventType: string, payload: Record<string, unknown>): Promise<void> {
  const dir = process.env.SOR_EVENT_DIR;
  if (!dir) return;
  const event = {
    actor: process.env.SOR_ACTOR ?? "system",
    backend: "opencode",
    created_at: new Date().toISOString(),
    event_type: eventType,
    payload,
    run_id: process.env.SOR_RUN_ID ?? "",
  };
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, "events.jsonl"), JSON.stringify(sortKeys(event)) + "\n", "utf8");
}

export const sorHookPlugin: Plugin = async () => {
  return {
    "tool.execute.before": async (input, output) => {
      await writeEvent("tool_call", {
        call_id: input.callID,
        phase: "before",
        session_id: input.sessionID,
        tool_input: output.args,
        tool_name: input.tool,
      });
    },
    "tool.execute.after": async (input, output) => {
      await writeEvent("tool_call", {
        call_id: input.callID,
        phase: "after",
        session_id: input.sessionID,
        tool_input: input.args,
        tool_name: input.tool,
        tool_output: output.output,
      });
    },
    event: async ({ event }: { event: Event }) => {
      if (event.type === "session.created") {
        await writeEvent("session.created", { session_id: event.properties.info.id });
      }
    },
  };
};

export default sorHookPlugin;

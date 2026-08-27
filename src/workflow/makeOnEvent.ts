import type { Role, RunContext } from "../types.ts";
import type { DashboardState } from "../tui/dashboard.ts";
import { logLine } from "../memory/sessionLog.ts";
import { ScoutTracker } from "./scoutTracker.ts";

type SorEmitFn = (
  ctx: RunContext | { runId: string; dryRun?: boolean },
  event: Record<string, unknown>,
) => Promise<void>;

interface MakeOnEventOpts {
  role: Role;
  ctx: RunContext;
  sorEmitFn: SorEmitFn;
  scoutTracker: ScoutTracker;
  pushStateThrottled: () => void;
  pushAgentEvent: (role: Role, ev: Record<string, unknown>) => void;
  pushNotice: ((msg: string) => void) | undefined;
  policyModel: string;
  dash: DashboardState;
  emitSor: boolean;
}

export function makeOnEvent(opts: MakeOnEventOpts): (ev: Record<string, unknown>) => void {
  const {
    role,
    ctx,
    sorEmitFn,
    scoutTracker,
    pushStateThrottled,
    pushAgentEvent,
    pushNotice,
    policyModel,
    dash,
    emitSor,
  } = opts;

  return (ev: Record<string, unknown>) => {
    if (scoutTracker.observe(role, ev)) {
      void logLine(ctx.rootDir, `[scout] invoked by ${role} (call ${scoutTracker.total}, ${scoutTracker.countFor(role)}/${role})`);
    }
    if (ev.t === "quota_exhausted") {
      pushNotice?.(`Gemini model ${String(ev.model ?? policyModel)} quota_exhausted until ${new Date(Number(ev.resetAt ?? Date.now())).toISOString()}`);
    }
    if (ev.t === "tool_call") {
      const a = dash.agents[role];
      if (a) {
        a.calls = {
          tools: (a.calls?.tools ?? 0) + 1,
          models: a.calls?.models ?? 0,
          skills: (a.calls?.skills ?? 0) + (ev.name === "load_skill" ? 1 : 0),
        };
      }
    }
    if (ev.t === "telemetry" && ev.event === "provider_completion" && ev.status === "completed") {
      const a = dash.agents[role];
      if (a) {
        a.calls = {
          tools: a.calls?.tools ?? 0,
          models: (a.calls?.models ?? 0) + 1,
          skills: a.calls?.skills ?? 0,
        };
      }
      if (emitSor) {
        void sorEmitFn(ctx, {
          event_type: "provider_completion",
          actor: role,
          backend: ctx.provider ?? "gemini",
          payload: {
            status: ev.status,
          },
        });
      }
    }
    if (emitSor) {
      if (ev.t === "reservation") {
        void sorEmitFn(ctx, {
          event_type: "reservation",
          actor: role,
          backend: ctx.provider ?? "gemini",
          payload: ev,
        });
      }
      if (ev.t === "reservation_rejection") {
        void sorEmitFn(ctx, {
          event_type: "reservation_rejection",
          actor: role,
          backend: ctx.provider ?? "gemini",
          payload: ev,
        });
      }
      if (ev.t === "retry") {
        void sorEmitFn(ctx, {
          event_type: "retry",
          actor: role,
          backend: ctx.provider ?? "gemini",
          payload: ev,
        });
      }
    }
    pushStateThrottled();
    pushAgentEvent(role, ev);
  };
}

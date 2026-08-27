import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DashboardState } from "../tui/dashboard.ts";
import type { Role } from "../types.ts";

type Phase = DashboardState["phase"];

const RESUME_ENV_KEYS = ["GEMINI_API_KEY", "OPENROUTER_API_KEY"] as const;

export function reloadApiKeyEnv(rootDir: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(join(rootDir, ".env"), "utf8");
  } catch {
    return [];
  }
  const updated: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    const key = m[1]!;
    if (!(RESUME_ENV_KEYS as readonly string[]).includes(key)) continue;
    let value = m[2] ?? "";
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
    updated.push(key);
  }
  return updated;
}

const PAUSE_REMINDER_MS = 5 * 60_000;
const PAUSE_BANNER_TEXT = "All models RPD exhausted — change GEMINI_API_KEY, then Resume";

export class PauseManager {
  private pausedRole: Role | null = null;
  private phaseBeforePause: Phase | null = null;
  private pauseReminder: ReturnType<typeof setInterval> | null = null;

  constructor(
    private setPhase: (phase: Phase | "failed") => void,
    private pushState: () => void,
  ) {}

  enterPause(role: Role, currentPhase: Phase): boolean {
    if (this.pausedRole !== null) return false;
    this.pausedRole = role;
    this.phaseBeforePause = currentPhase;
    return true;
  }

  startReminder(): void {
    if (this.pauseReminder) return;
    this.pauseReminder = setInterval(() => {
      console.error(`[quota] still paused — all Gemini models RPD exhausted (${this.pausedRole}); change your API key, then Resume`);
    }, PAUSE_REMINDER_MS);
    this.pauseReminder.unref?.();
  }

  teardownPause(web?: { pushPause?: (paused: boolean) => void }): void {
    this.pausedRole = null;
    this.phaseBeforePause = null;
    if (this.pauseReminder) {
      clearInterval(this.pauseReminder);
      this.pauseReminder = null;
    }
    web?.pushPause?.(false);
  }

  exitPause(web?: { pushPause?: (paused: boolean) => void }): void {
    const restorePhase = this.phaseBeforePause;
    this.teardownPause(web);
    if (restorePhase !== null) {
      this.setPhase(restorePhase);
    }
    this.pushState();
  }

  isPaused(): boolean {
    return this.pausedRole !== null;
  }

  getPausedRole(): Role | null {
    return this.pausedRole;
  }

  getBannerText(): string {
    return PAUSE_BANNER_TEXT;
  }
}

let activeResumeHandler: (() => boolean) | null = null;

export function resumeFromPause(): boolean {
  return activeResumeHandler ? activeResumeHandler() : false;
}

export function setActiveResumeHandler(handler: (() => boolean) | null): void {
  activeResumeHandler = handler;
}

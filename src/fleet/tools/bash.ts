import { spawn } from "node:child_process";
import {
  ToolInputError,
  asRecord,
  asString,
  resolveInside,
  type ToolImpl,
  type ToolResult,
} from "./common.ts";

export const BASH_OUTPUT_CAP = 20_000;
export const BASH_TIMEOUT_DEFAULT_MS = 10 * 60 * 1000;

export function bashTimeoutMs(): number {
  const envMs = Number(process.env.WORKER_TIMEOUT_MS ?? "");
  return envMs > 0 && Number.isFinite(envMs)
    ? Math.floor(envMs)
    : BASH_TIMEOUT_DEFAULT_MS;
}

function truncate(raw: string): string {
  return raw.length > BASH_OUTPUT_CAP ? raw.slice(0, BASH_OUTPUT_CAP) : raw;
}

export const bashTool: ToolImpl = {
  schema: {
    type: "object",
    properties: {
      command: { type: "string", description: "shell command to run in the worktree" },
    },
    required: ["command"],
    additionalProperties: false,
  },
  async exec(input, ctx): Promise<ToolResult> {
    let command: string;
    try {
      command = asString(asRecord(input), "command");
    } catch (err) {
      return err instanceof ToolInputError
        ? { ok: false, error: err.message }
        : { ok: false, error: String(err) };
    }
    let cwd: string;
    try {
      cwd = resolveInside(ctx.worktreeDir, ".");
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    return new Promise<ToolResult>((settle) => {
      let output = "";
      let timedOut = false;
      const child = spawn(command, [], { cwd, shell: true, detached: true });
      const timer = setTimeout(() => {
        timedOut = true;
        if (typeof child.pid === "number") {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
        child.stdout.destroy();
        child.stderr.destroy();
      }, bashTimeoutMs());
      const collect = (chunk: Buffer | string): void => {
        if (output.length >= BASH_OUTPUT_CAP + 4096) return;
        output += chunk.toString("utf8");
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      child.on("error", (err) => {
        clearTimeout(timer);
        settle({ ok: false, error: `spawn failed: ${err.message}` });
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        const text = truncate(output);
        if (timedOut || signal === "SIGKILL") {
          settle({
            ok: false,
            error: `bash timed out after ${bashTimeoutMs()}ms\n${text}`,
          });
          return;
        }
        const exitCode = code ?? -1;
        settle({
          ok: true,
          content:
            `${text}${text ? "\n" : ""}[exit code ${exitCode}]`,
          exitCode,
        });
      });
    });
  },
};

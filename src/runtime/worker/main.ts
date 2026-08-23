import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type OpenAI from "openai";
import { analyzerDef } from "../../fleet/agents/analyzer.ts";
import { coderDef } from "../../fleet/agents/coder.ts";
import { plannerDef } from "../../fleet/agents/planner.ts";
import { prDef } from "../../fleet/agents/pr.ts";
import { reviewerDef } from "../../fleet/agents/reviewer.ts";
import { testerDef } from "../../fleet/agents/tester.ts";
import type { FleetAgentDef } from "../../fleet/types.ts";
import { runAgent, type WireEvent } from "../../fleet/loop.ts";
import { injectSkills } from "../../fleet/skills/loader.ts";
import { buildRegistry, type WtCtx } from "../../fleet/tools/registry.ts";
import { policyFor } from "../../models/modelPolicy.ts";
import {
  getClientForProvider,
  getFleetProviders,
  providersWithKeys,
} from "../../providers/registry.ts";
import type { ProviderName, Role } from "../../types.ts";

const DEFS: Record<Role, FleetAgentDef> = {
  analyzer: analyzerDef,
  planner: plannerDef,
  coder: coderDef,
  tester: testerDef,
  reviewer: reviewerDef,
  pr: prDef,
};

const ROLES: readonly string[] = Object.keys(DEFS);

export interface WorkerJobCtx {
  rootDir: string;
  worktreeDir: string;
  tracesDir: string;
  runDir: string;
  dryRun: boolean;
  extraTask?: string;
}

export interface WorkerJob {
  role: Role;
  task: string;
  ctx: WorkerJobCtx;
}

export function parseWorkerJob(raw: string): WorkerJob {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`job is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("job must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.role !== "string" || !ROLES.includes(obj.role)) {
    throw new Error(`job.role must be one of ${ROLES.join("|")}`);
  }
  if (typeof obj.task !== "string") {
    throw new Error("job.task must be a string");
  }
  const ctx = obj.ctx;
  if (typeof ctx !== "object" || ctx === null) {
    throw new Error("job.ctx must be an object");
  }
  const c = ctx as Record<string, unknown>;
  for (const key of ["rootDir", "worktreeDir", "tracesDir", "runDir"] as const) {
    if (typeof c[key] !== "string" || (c[key] as string).length === 0) {
      throw new Error(`job.ctx.${key} must be a non-empty string`);
    }
  }
  if (typeof c.dryRun !== "boolean") {
    throw new Error("job.ctx.dryRun must be a boolean");
  }
  if (c.extraTask !== undefined && typeof c.extraTask !== "string") {
    throw new Error("job.ctx.extraTask must be a string");
  }
  return {
    role: obj.role as Role,
    task: obj.task,
    ctx: {
      rootDir: c.rootDir as string,
      worktreeDir: c.worktreeDir as string,
      tracesDir: c.tracesDir as string,
      runDir: c.runDir as string,
      dryRun: c.dryRun as boolean,
      ...(typeof c.extraTask === "string" ? { extraTask: c.extraTask } : {}),
    },
  };
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function emit(evt: WireEvent): void {
  outstandingWrites += 1;
  process.stdout.write(JSON.stringify(evt) + "\n", () => {
    outstandingWrites -= 1;
  });
}

function failOut(error: string): number {
  emit({ t: "error", error });
  console.error(`[worker] ${error}`);
  return 1;
}

/** First keyed provider in FLEET_PROVIDERS order + its policy model for `role`. */
export function resolveProviderModel(role: Role): { provider: ProviderName; model: string } | null {
  const candidates = providersWithKeys(getFleetProviders());
  const provider = candidates[0];
  if (!provider) return null;
  return { provider, model: policyFor(role, provider).model };
}

async function run(): Promise<number> {
  const controller = new AbortController();
  const onSignal = (): void => {
    controller.abort();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  const raw = await readStdin();
  let job: WorkerJob;
  try {
    job = parseWorkerJob(raw);
  } catch (err) {
    return failOut(err instanceof Error ? err.message : String(err));
  }

  const sessionId = randomUUID();
  const def = DEFS[job.role];
  const systemPrompt = injectSkills(def.systemPrompt, job.role);
  const registry = buildRegistry(def);
  const wtCtx: WtCtx = {
    worktreeDir: job.ctx.worktreeDir,
    role: job.role,
    runDir: job.ctx.runDir,
  };

  if (job.ctx.dryRun) {
    const resolved = resolveProviderModel(job.role);
    const provider: ProviderName = resolved?.provider ?? "gemini";
    const model = resolved?.model ?? policyFor(job.role).model;
    const text = `[dry-run] ${job.role} would run here.`;
    emit({ t: "init", role: job.role, model, provider, sessionId });
    emit({ t: "text", part: { text } });
    emit({ t: "result", text });
    emit({
      t: "step_finish",
      usage: { input: 0, output: 0, reasoning: 0, cached: 0, cacheWrite: 0, total: 0 },
      costUsd: 0,
    });
    return 0;
  }

  const resolved = resolveProviderModel(job.role);
  if (!resolved) {
    return failOut("no provider keys configured");
  }
  const { provider, model } = resolved;
  const client: OpenAI = getClientForProvider(provider);
  emit({ t: "init", role: job.role, model, provider, sessionId });

  const task = job.ctx.extraTask ? `${job.task}\n\n${job.ctx.extraTask}` : job.task;

  const outcome = await runAgent({
    client,
    model,
    systemPrompt,
    task,
    registry,
    wtCtx,
    emit,
    signal: controller.signal,
    provider,
  });

  process.off("SIGTERM", onSignal);
  process.off("SIGINT", onSignal);

  if (!outcome.ok) {
    console.error(`[worker] run failed: ${outcome.error ?? "unknown error"}`);
    return 1;
  }
  return 0;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  void argv;
  try {
    return await run();
  } catch (err) {
    return failOut(err instanceof Error ? err.message : String(err));
  }
}

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

let outstandingWrites = 0;

/** Pipe writes are async; wait for their callbacks so NDJSON is never dropped on process.exit. */
async function flushAndExit(code: number): Promise<never> {
  const deadline = Date.now() + 2000;
  while (outstandingWrites > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  process.exit(code);
}

if (isEntry) {
  void main().then((code) => flushAndExit(code));
}

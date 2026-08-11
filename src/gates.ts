import { createInterface } from "node:readline";

/** Ask a yes/no question on stdin. Returns true only on an explicit yes. */
export async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = await new Promise<string>((res) => rl.question(`\n${question} [y/N] `, res));
    return /^\s*(y|yes)\s*$/i.test(ans);
  } finally {
    rl.close();
  }
}

/** Free-text prompt (e.g. to collect change requests when a gate is rejected). */
export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await new Promise<string>((res) => rl.question(`${question} `, res))).trim();
  } finally {
    rl.close();
  }
}

export interface GateResult {
  approved: boolean;
  feedback?: string; // change requests captured on rejection
}

/**
 * A human approval gate. Shows `body`, asks to approve; on rejection optionally captures
 * feedback so the orchestrator can loop. `interactive=false` (dry-run/CI) auto-approves.
 */
export async function gate(
  label: string,
  body: string,
  opts: { interactive: boolean; captureFeedbackOnReject?: boolean } = { interactive: true },
): Promise<GateResult> {
  const bar = "─".repeat(72);
  process.stdout.write(`\n${bar}\n▶ ${label}\n${bar}\n${body}\n`);

  if (!opts.interactive) {
    process.stdout.write("\n(auto-approved: non-interactive mode)\n");
    return { approved: true };
  }

  const approved = await confirm(`Approve: ${label}?`);
  if (approved || !opts.captureFeedbackOnReject) return { approved };

  const feedback = await ask("What should change? (blank to abort):");
  return { approved: false, feedback: feedback || undefined };
}

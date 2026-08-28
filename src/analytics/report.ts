// Analytics report generator — builds a cross-run markdown report from the
// 4 analytics queries. Exported as a library function and runnable directly
// via `npm run analytics`.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	type BackendRow,
	costPerBackend,
	costPerIteration,
	costPerRole,
	type FailingRoleRow,
	type IterationRow,
	type RoleRow,
	topFailingRoles,
} from "./queries.ts";

function formatCost(value: number): string {
	return `$${value.toFixed(2)}`;
}

function formatPercent(value: number): string {
	return `${value.toFixed(0)}%`;
}

function roleTable(rows: RoleRow[]): string {
	const header = [
		"| Role | Model | Runs | Total Cost | Avg per Run | Success Rate |",
		"|------|-------|------|------------|-------------|--------------|",
	];
	const body = rows.map(
		(r) =>
			`| ${r.role} | ${r.model} | ${r.count} | ${formatCost(r.total_cost_usd)} | ` +
			`${formatCost(r.avg_cost_per_run)} | ${formatPercent(r.success_rate)} |`,
	);
	return [...header, ...body].join("\n");
}

function backendTable(rows: BackendRow[]): string {
	const header = [
		"| Backend | Runs | Total Cost | Success Rate |",
		"|---------|------|------------|--------------|",
	];
	const body = rows.map(
		(r) =>
			`| ${r.backend} | ${r.count} | ${formatCost(r.total_cost_usd)} | ` +
			`${formatPercent(r.success_rate)} |`,
	);
	return [...header, ...body].join("\n");
}

function iterationTable(rows: IterationRow[]): string {
	const header = [
		"| Iteration | Runs | Total Cost | Success Rate |",
		"|-----------|------|------------|--------------|",
	];
	const body = rows.map(
		(r) =>
			`| ${r.iteration} | ${r.count} | ${formatCost(r.total_cost_usd)} | ` +
			`${formatPercent(r.success_rate)} |`,
	);
	return [...header, ...body].join("\n");
}

function failingRoleTable(rows: FailingRoleRow[]): string {
	const header = [
		"| Role | Model | Failures | Failure Rate |",
		"|------|-------|----------|--------------|",
	];
	const body = rows.map(
		(r) =>
			`| ${r.role} | ${r.model} | ${r.failure_count} | ` +
			`${formatPercent(r.failure_rate)} |`,
	);
	return [...header, ...body].join("\n");
}

/** Build a full analytics markdown report for the given date window. */
export async function generateReport(
	from: string,
	to: string,
	repo?: string,
): Promise<string> {
	const [roles, backends, iterations, failing] = await Promise.all([
		costPerRole(from, to, repo),
		costPerBackend(from, to, repo),
		costPerIteration(from, to, repo),
		topFailingRoles(from, to, repo, 10),
	]);

	const sections = [
		`# Analytics Report: ${from} to ${to}`,
		"",
		"## Cost by Role",
		roleTable(roles),
		"",
		"## Cost by Backend",
		backendTable(backends),
		"",
		"## Cost by Iteration",
		iterationTable(iterations),
		"",
		"## Top Failing Roles",
		failingRoleTable(failing),
	];

	return [...sections, ""].join("\n");
}

function todayIso(): string {
	return new Date().toISOString().slice(0, 10);
}

function daysAgoIso(days: number): string {
	const d = new Date();
	d.setDate(d.getDate() - days);
	return d.toISOString().slice(0, 10);
}

function parseArgv(argv: string[]): { from: string; to: string } {
	let from: string | undefined;
	let to: string | undefined;
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === "--from") {
			from = argv[i + 1];
		} else if (argv[i] === "--to") {
			to = argv[i + 1];
		}
	}
	return {
		from: from ?? daysAgoIso(30),
		to: to ?? todayIso(),
	};
}

async function main(): Promise<void> {
	const { from, to } = parseArgv(process.argv.slice(2));
	const report = await generateReport(from, to);

	process.stdout.write(report);
	process.stdout.write("\n");

	const date = todayIso();
	const dir = path.join(process.cwd(), ".runs");
	await mkdir(dir, { recursive: true });
	const outPath = path.join(dir, `analytics-${date}.md`);
	await writeFile(outPath, report, "utf8");
	console.error(`[analytics] wrote ${outPath}`);
}

const directlyRun =
	process.argv[1] &&
	fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (directlyRun) {
	void main();
}

#!/usr/bin/env node
// Test fixture: fake fleet worker implementing the SPEC §6 wire contract.
// Reads ONE JSON job from stdin, emits init/text/result/step_finish NDJSON on
// stdout, exits 0. FAKE_FAIL_PROVIDERS (comma-separated) makes it emit an
// error event and exit 1 for those SOR_PROVIDER values instead.
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
	raw += c;
});
process.stdin.on("end", run);

const send = (ev) => process.stdout.write(`${JSON.stringify(ev)}\n`);

function run() {
	const job = JSON.parse(raw);
	const provider = process.env.SOR_PROVIDER;
	send({
		t: "init",
		role: job.role,
		model: "fake-model",
		provider,
		sessionId: "sess-fake-1",
	});
	const failed = (process.env.FAKE_FAIL_PROVIDERS ?? "")
		.split(",")
		.map((p) => p.trim())
		.filter(Boolean);
	if (failed.includes(provider)) {
		send({ t: "error", error: `synthetic failure on ${provider}` });
		console.error(`[fake-worker] failing on ${provider}`);
		process.exit(1);
	}
	const text =
		`hello from ${provider} re: ${job.task}` +
		(job.ctx?.extraTask ? ` [extra: ${job.ctx.extraTask}]` : "");
	send({ t: "text", part: { text } });
	send({ t: "result", text });
	send({
		t: "step_finish",
		usage: {
			input: 3,
			output: 2,
			reasoning: 0,
			cached: 0,
			cacheWrite: 0,
			total: 5,
		},
		costUsd: 0,
	});
	process.exit(0);
}

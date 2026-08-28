import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SERVER_PATH = join(REPO_ROOT, "src", "mcp", "fleetServer.ts");

interface Conn {
	client: Client;
	transport: StdioClientTransport;
}

let fakeGhDir: string | null = null;
const opened: Conn[] = [];

beforeAll(() => {
	fakeGhDir = mkdtempSync(join(tmpdir(), "fake-gh-"));
	const script = [
		"#!/bin/sh",
		'printf \'{"title":"Integration Issue","body":"body text","labels":[{"name":"bug"}],"number":7,"html_url":"https://example.invalid/pr/7"}\\n\'',
	].join("\n");
	writeFileSync(join(fakeGhDir, "gh"), `${script}\n`);
	chmodSync(join(fakeGhDir, "gh"), 0o755);
});

afterAll(() => {
	if (fakeGhDir) {
		rmSync(fakeGhDir, { recursive: true, force: true });
		fakeGhDir = null;
	}
});

async function connect(
	role: string,
	opts?: { fakeGh?: boolean },
): Promise<Conn> {
	const transport = new StdioClientTransport({
		command: "tsx",
		args: [SERVER_PATH, role],
		cwd: REPO_ROOT,
		...(opts?.fakeGh && fakeGhDir
			? { env: { PATH: `${fakeGhDir}:${process.env.PATH ?? ""}` } }
			: {}),
	});
	const client = new Client(
		{ name: "fleet-mcp-test", version: "1.0.0" },
		{ capabilities: {} },
	);
	await client.connect(transport);
	const conn = { client, transport };
	opened.push(conn);
	return conn;
}

afterEach(async () => {
	while (opened.length > 0) {
		const conn = opened.pop();
		if (!conn) break;
		await conn.client.close().catch(() => {});
		await conn.transport.close().catch(() => {});
	}
});

function resultText(content: unknown): string {
	return (content as Array<{ text?: string }>)
		.map((c) => c.text ?? "")
		.join("");
}

describe("MCP stdio integration — denied role (coder) over real server", () => {
	it("listTools yields no tools for denied role coder", {
		timeout: 30000,
	}, async () => {
		const { client } = await connect("coder");
		const result = await client.listTools();
		expect(result.tools).toEqual([]);
	});

	it("callTool get_issue is denied for coder", { timeout: 30000 }, async () => {
		const { client } = await connect("coder");
		const result = await client.callTool({
			name: "get_issue",
			arguments: { owner: "o", repo: "r", number: 1 },
		});
		expect(result.isError).toBe(true);
		expect(resultText(result.content)).toContain(
			"Tool get_issue not allowed for role coder",
		);
	});

	it("callTool create_pr is denied for coder even with spoofed _meta role analyzer", {
		timeout: 30000,
	}, async () => {
		const { client } = await connect("coder");
		const result = await client.callTool({
			name: "create_pr",
			arguments: {
				owner: "o",
				repo: "r",
				head: "h",
				base: "b",
				title: "t",
				body: "b",
			},
			_meta: { role: "analyzer" },
		});
		expect(result.isError).toBe(true);
		expect(resultText(result.content)).toContain(
			"Tool create_pr not allowed for role coder",
		);
	});
});

describe("MCP stdio integration — unknown/unmapped role denies everything", () => {
	it("listTools yields nothing and callTool is denied for unmapped role intruder", {
		timeout: 30000,
	}, async () => {
		const conn = await connect("intruder");
		const list = await conn.client.listTools();
		expect(list.tools).toEqual([]);

		const call = await conn.client.callTool({
			name: "get_issue",
			arguments: { owner: "o", repo: "r", number: 1 },
		});
		expect(call.isError).toBe(true);
		expect(resultText(call.content)).toContain("not allowed for role intruder");
	});
});

describe("MCP stdio integration — allowed role (analyzer) positive control", () => {
	it("listTools exposes exactly the analyzer allowlist", {
		timeout: 30000,
	}, async () => {
		const { client } = await connect("analyzer");
		const result = await client.listTools();
		expect(result.tools.map((t) => t.name)).toEqual([
			"get_issue",
			"get_issue_comments",
		]);
	});

	it("callTool get_issue executes through gh-backed handler", {
		timeout: 30000,
	}, async () => {
		const { client } = await connect("analyzer", { fakeGh: true });
		const result = await client.callTool({
			name: "get_issue",
			arguments: { owner: "o", repo: "r", number: 7 },
		});
		expect(result.isError).toBeFalsy();
		const parsed = JSON.parse(resultText(result.content)) as {
			title: string;
			labels: string[];
		};
		expect(parsed.title).toBe("Integration Issue");
		expect(parsed.labels).toEqual(["bug"]);
	});

	it("callTool create_pr stays denied for analyzer", {
		timeout: 30000,
	}, async () => {
		const { client } = await connect("analyzer");
		const result = await client.callTool({
			name: "create_pr",
			arguments: {
				owner: "o",
				repo: "r",
				head: "h",
				base: "b",
				title: "t",
				body: "b",
			},
		});
		expect(result.isError).toBe(true);
		expect(resultText(result.content)).toContain(
			"Tool create_pr not allowed for role analyzer",
		);
	});
});

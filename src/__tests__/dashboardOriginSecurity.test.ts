import { afterEach, describe, expect, it } from "vitest";
import { WebDashboard } from "../dashboard/webDashboard.ts";

describe("dashboard same-origin security", () => {
	let dashboard: WebDashboard | undefined;

	afterEach(async () => {
		await dashboard?.close();
		dashboard = undefined;
	});

	async function startDashboard(): Promise<string> {
		dashboard = new WebDashboard(0, "/tmp");
		const info = await dashboard.start();
		if (!info) throw new Error("dashboard failed to start");
		return info.url;
	}

	it("rejects mutation requests from an unrelated origin", async () => {
		const baseUrl = await startDashboard();
		const response = await fetch(new URL("/api/provider", baseUrl), {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: "https://attacker.example",
			},
			body: JSON.stringify({ provider: "ollama" }),
		});
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ ok: false });
	});

	it("rejects cross-origin preflight requests without reflecting their origin", async () => {
		const baseUrl = await startDashboard();
		const response = await fetch(new URL("/api/provider", baseUrl), {
			method: "OPTIONS",
			headers: {
				Origin: "https://attacker.example",
				"Access-Control-Request-Method": "POST",
			},
		});
		expect(response.status).toBe(403);
		expect(response.headers.get("access-control-allow-origin")).toBeNull();
	});

	it("allows same-origin dashboard mutations", async () => {
		const baseUrl = await startDashboard();
		const response = await fetch(new URL("/api/provider", baseUrl), {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: new URL(baseUrl).origin,
			},
			body: JSON.stringify({ provider: "ollama" }),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			provider: "ollama",
		});
	});
});

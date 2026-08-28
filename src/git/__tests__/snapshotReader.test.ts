import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildSkeletonMap,
	readSelectedFileSymbols,
} from "../snapshotReader.ts";

function git(dir: string, args: string[]): string {
	return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

function mkRepo(tag: string, files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), `skel-${tag}-`));
	git(dir, ["init", "-q", "-b", "main"]);
	git(dir, ["config", "user.name", "Test"]);
	git(dir, ["config", "user.email", "test@example.com"]);
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(dir, rel);
		mkdirSync(join(abs, ".."), { recursive: true });
		writeFileSync(abs, content, "utf8");
	}
	git(dir, ["add", "."]);
	git(dir, ["commit", "-q", "-m", "init"]);
	return dir;
}

const TS_REPO = mkRepo("ts", {
	"src/modA.ts": [
		"export class Foo {",
		"  private a: number;",
		"  bar(): void {",
		"    // heavy body",
		"    this.a = 1;",
		"  }",
		"}",
		"export interface Bar { x: number; y: string; }",
		"export type Id = string | number;",
		"export enum Kind { A, B }",
		"export function makeFoo(name: string, opts: { a: number }): Foo {",
		"  return new Foo();",
		"}",
		"export default function init(): void {}",
	].join("\n"),
	"src/modB.py": [
		"class Handler:",
		"    pass",
		"def greet(name: str) -> None:",
		"    return None",
		"TYPE = str",
	].join("\n"),
});

describe("buildSkeletonMap", () => {
	it("captures symbol declarations while stripping bodies", async () => {
		const map = await buildSkeletonMap(TS_REPO);
		expect(map.totalFiles).toBe(2);
		const a = map.files.find((f: { path: string }) => f.path === "src/modA.ts");
		expect(a).toBeDefined();
		const names = a?.symbols.map(
			(s: { kind: string; name: string }) => `${s.kind}:${s.name}`,
		);
		expect(names).toContain("class:Foo");
		expect(names).toContain("interface:Bar");
		expect(names).toContain("type:Id");
		expect(names).toContain("enum:Kind");
		expect(names).toContain("function:makeFoo");
		expect(names).toContain("default:init");
		// bodies must be stripped: no function body text in any header
		if (a?.symbols) {
			for (const s of a.symbols) {
				expect(s.header).not.toContain("// heavy body");
				expect(s.header).not.toMatch(/return new Foo/);
			}
		}
	});

	it("stays within the small token budget", async () => {
		const map = await buildSkeletonMap(TS_REPO);
		let chars = 0;
		for (const f of map.files) {
			for (const s of f.symbols) chars += s.header.length + 1;
		}
		expect(chars).toBeLessThan(12_000);
	});

	it("readSelectedFileSymbols returns header-only text", async () => {
		const out = await readSelectedFileSymbols(TS_REPO, "src/modA.ts");
		expect(out).toContain("// File: src/modA.ts");
		expect(out).toContain("export class Foo");
		expect(out).toContain("export interface Bar");
		expect(out).not.toContain("// heavy body");
		expect(out).not.toContain("return new Foo");
	});

	it("readSelectedFileSymbols reports unreadable/binary for missing files", async () => {
		const out = await readSelectedFileSymbols(TS_REPO, "does/not/exist.ts");
		expect(out).toContain("// File: does/not/exist.ts");
	});
});

describe("buildSkeletonMap budget cap", () => {
	it("sets tokenBudgetExceeded=true when many files exceed the cap", async () => {
		const files: Record<string, string> = {};
		for (let i = 0; i < 300; i++) {
			files[`src/f${i}.ts`] =
				`export class C${i} { constructor(public a: number, public b: string, public c: boolean) {} bar(): void { /*body*/ } }\n`;
		}
		const dir = mkRepo("big", files);
		try {
			const map = await buildSkeletonMap(dir);
			expect(map.totalFiles).toBe(300);
			expect(map.tokenBudgetExceeded).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("cleanup", () => {
		rmSync(TS_REPO, { recursive: true, force: true });
	});
});

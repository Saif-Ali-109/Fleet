import { describe, expect, it } from "vitest";
import { toRepoSlug } from "../github/gh.ts";

describe("toRepoSlug", () => {
	it.each([
		["owner/repo", "owner/repo"],
		["https://github.com/owner/repo", "owner/repo"],
		["https://github.com/owner/repo.git", "owner/repo"],
		["git@github.com:owner/repo.git", "owner/repo"],
	])("normalizes %s", (input, expected) => {
		expect(toRepoSlug(input)).toBe(expected);
	});
	it.each([
		"https://github.com.evil.test/owner/repo",
		"https://evil.test/github.com/owner/repo",
		"git@evil.test:owner/repo.git",
		"owner/../repo",
		"--upload-pack=evil",
		"owner/repo/extra",
	])("rejects unsafe repository identifier %s", (input) => {
		expect(() => toRepoSlug(input)).toThrow();
	});
});

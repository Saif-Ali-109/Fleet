import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseIssueEvent, verifyWebhookSignature } from "../daemon/webhook.ts";

// ---------------------------------------------------------------------------
// verifyWebhookSignature
// ---------------------------------------------------------------------------

function hmacHex(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

describe("verifyWebhookSignature", () => {
  const secret = "test-secret-123";
  const body = '{"action":"opened","issue":{}}';

  it("passes with a valid signature", () => {
    const sig = `sha256=${hmacHex(body, secret)}`;
    expect(verifyWebhookSignature(body, sig, secret)).toBe(true);
  });

  it("fails with a wrong signature", () => {
    const sig = "sha256=" + "0".repeat(64);
    expect(verifyWebhookSignature(body, sig, secret)).toBe(false);
  });

  it("fails when signature256 is undefined", () => {
    expect(verifyWebhookSignature(body, undefined, secret)).toBe(false);
  });

  it("returns false without throwing for a truncated / garbage-length header", () => {
    // This exercises the length-mismatch branch: timingSafeEqual would throw
    // RangeError if the guard were missing.
    const garbage = "sha256=" + "ab"; // only 2 hex chars vs 64 expected
    expect(() =>
      verifyWebhookSignature(body, garbage, secret),
    ).not.toThrow();
    expect(verifyWebhookSignature(body, garbage, secret)).toBe(false);
  });

  it("fails with an empty secret", () => {
    const sig = `sha256=${hmacHex(body, "")}`;
    expect(verifyWebhookSignature(body, sig, "")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseIssueEvent
// ---------------------------------------------------------------------------

describe("parseIssueEvent", () => {
  const openedPayload = {
    action: "opened",
    issue: { number: 42, title: "Fix the bug" },
    repository: { full_name: "owner/repo" },
  };

  it("parses an opened event to the full object", () => {
    const result = parseIssueEvent(openedPayload);
    expect(result).toEqual({
      slug: "owner/repo",
      number: 42,
      title: "Fix the bug",
      action: "opened",
    });
  });

  it("parses a reopened event with action 'reopened'", () => {
    const payload = { ...openedPayload, action: "reopened" };
    const result = parseIssueEvent(payload);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("reopened");
  });

  it("defaults title to '' when title is missing", () => {
    const payload = {
      action: "opened",
      issue: { number: 7 },
      repository: { full_name: "o/r" },
    };
    const result = parseIssueEvent(payload);
    expect(result!.title).toBe("");
  });

  it("normalizes a mixed-case full_name to a lowercase slug on opened", () => {
    const payload = {
      action: "opened",
      issue: { number: 26, title: "Fix the bug" },
      repository: { full_name: "Saif-Ali-109/Demo-Repo" },
    };
    expect(parseIssueEvent(payload)!.slug).toBe("saif-ali-109/demo-repo");
  });

  it("normalizes a mixed-case full_name to a lowercase slug on reopened", () => {
    const payload = {
      action: "reopened",
      issue: { number: 26, title: "Fix the bug" },
      repository: { full_name: "SAIF-ALI-109/demo-repo" },
    };
    const result = parseIssueEvent(payload);
    expect(result!.slug).toBe("saif-ali-109/demo-repo");
    expect(result!.action).toBe("reopened");
  });

  // --- actions that should be ignored (→ null) ---

  it("returns null for a ping action", () => {
    expect(parseIssueEvent({ action: "ping", issue: { number: 1 }, repository: { full_name: "o/r" } })).toBeNull();
  });

  it("returns null for a closed action", () => {
    expect(parseIssueEvent({ action: "closed", issue: { number: 1 }, repository: { full_name: "o/r" } })).toBeNull();
  });

  it("returns null for a labeled action", () => {
    expect(parseIssueEvent({ action: "labeled", issue: { number: 1 }, repository: { full_name: "o/r" } })).toBeNull();
  });

  // --- malformed payloads ---

  it("returns null for null payload", () => {
    expect(parseIssueEvent(null)).toBeNull();
  });

  it("returns null for empty object", () => {
    expect(parseIssueEvent({})).toBeNull();
  });

  it("returns null when issue is missing", () => {
    expect(parseIssueEvent({ action: "opened", repository: { full_name: "o/r" } })).toBeNull();
  });

  it("returns null when repository is missing", () => {
    expect(parseIssueEvent({ action: "opened", issue: { number: 1 } })).toBeNull();
  });

  it("returns null when issue.number is not a number", () => {
    expect(
      parseIssueEvent({
        action: "opened",
        issue: { number: "not-a-number", title: "hi" },
        repository: { full_name: "o/r" },
      }),
    ).toBeNull();
  });

  it("returns null for a string payload", () => {
    expect(parseIssueEvent("hello")).toBeNull();
  });
});

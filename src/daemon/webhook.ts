import { createHmac, timingSafeEqual } from "node:crypto";

export type WebhookIssueAction = "opened" | "reopened";

export interface ParsedIssueEvent {
  slug: string;
  number: number;
  title: string;
  action: WebhookIssueAction;
}

/** HMAC-SHA256 verification of GitHub's X-Hub-Signature-256 header.
 * Length pre-check before timingSafeEqual (it THROWS RangeError on length
 * mismatch). Returns false on missing signature/secret/garbage. Never throws. */
export function verifyWebhookSignature(
  rawBody: string,
  signature256: string | undefined,
  secret: string,
): boolean {
  if (!secret) return false;
  if (!signature256) return false;

  const prefix = "sha256=";
  if (!signature256.startsWith(prefix)) return false;

  const receivedHex = signature256.slice(prefix.length);
  if (receivedHex.length === 0) return false;

  const expectedHex = createHmac("sha256", secret).update(rawBody).digest("hex");

  // timingSafeEqual throws RangeError when lengths differ — guard first
  if (receivedHex.length !== expectedHex.length) return false;

  const a = Buffer.from(receivedHex, "utf-8");
  const b = Buffer.from(expectedHex, "utf-8");
  return timingSafeEqual(a, b);
}

/** Parse a GitHub `issues` webhook payload. Accepts ONLY action "opened" or
 * "reopened" (ping/closed/labeled/etc → null). Extracts repository.full_name,
 * issue.number, issue.title. Returns null on any malformed shape. */
export function parseIssueEvent(payload: unknown): ParsedIssueEvent | null {
  if (typeof payload !== "object" || payload === null) return null;

  const obj = payload as Record<string, unknown>;

  // action
  if (typeof obj.action !== "string") return null;
  const action = obj.action as string;
  if (action !== "opened" && action !== "reopened") return null;

  // issue
  const issue = obj.issue;
  if (typeof issue !== "object" || issue === null) return null;
  const issueObj = issue as Record<string, unknown>;
  if (typeof issueObj.number !== "number") return null;
  const title = typeof issueObj.title === "string" ? issueObj.title : "";

  // repository
  const repo = obj.repository;
  if (typeof repo !== "object" || repo === null) return null;
  const repoObj = repo as Record<string, unknown>;
  if (typeof repoObj.full_name !== "string") return null;

  return { slug: repoObj.full_name, number: issueObj.number, title, action };
}

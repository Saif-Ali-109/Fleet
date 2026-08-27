// Key management for SOR key rotation.
// Reads HMAC secrets from environment variables named SOR_KEY_<key_id> (e.g., SOR_KEY_V1).
// Current key ID is taken from SOR_KEY_ID (default "v1").

import { sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Retrieve the HMAC secret for a given key ID from the environment.
 *  Environment variable name: SOR_KEY_<key_id> (key_id is uppercase, dots and hyphens replaced with underscores).
 *  Returns undefined if not set.
 */
export function getKey(keyId: string): string | undefined {
  // Normalize key ID to uppercase and replace non-alphanumeric with underscores.
  const normalized = keyId
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "_");
  const envVar = `SOR_KEY_${normalized}`;
  return process.env[envVar] ?? (normalized === "V1" ? process.env.SOR_SIGNING_KEY : undefined);
}

/** Get the current key ID from the environment (default "v1"). */
export function getCurrentKeyId(): string {
  return process.env.SOR_KEY_ID ?? "v1";
}

/** Get the HMAC secret for the current key ID.
 *  Throws if not set.
 */
export function getCurrentKey(): string {
  const keyId = getCurrentKeyId();
  const key = getKey(keyId);
  if (key === undefined) {
    throw new Error(
      `SOR_KEY_${keyId.toUpperCase().replace(/[^A-Z0-9]/g, "_")} is not set. ` +
        "Set it in .env or export it before using the current key."
    );
  }
  return key;
}

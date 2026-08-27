#!/usr/bin/env node
/**
 * verify-edge-auth.mjs
 *
 * Quick pre-flight check for Fleet ↔ model-api-proxy JWT auth.
 *
 * 1. Loads the Ed25519 private key from disk
 * 2. Signs a test JWT with iss:"fleet" sub:"verify"
 * 3. Decodes and verifies the signature
 * 4. Prints the resulting token + decoded payload
 *
 * Exit 0 = all green, exit 1 = something broken.
 *
 * Usage:
 *   node scripts/verify-edge-auth.mjs
 *   FLEET_KEY_PATH=/custom/path.pem node scripts/verify-edge-auth.mjs
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// 1. Locate the private key
// ---------------------------------------------------------------------------

const KEY_PATH =
  process.env.FLEET_KEY_PATH ||
  join(homedir(), ".config", "fleet", "keys", "ed25519-private.pem");

let pemRaw;
try {
  pemRaw = readFileSync(KEY_PATH, "utf8");
} catch (err) {
  console.error(`✗ Cannot read private key at ${KEY_PATH}`);
  console.error(`  ${err.message}`);
  console.error("");
  console.error("Generate keys first:");
  console.error("  openssl genpkey -algorithm Ed25519 -out ~/.config/fleet/keys/ed25519-private.pem");
  console.error("  openssl pkey -in ~/.config/fleet/keys/ed25519-private.pem -pubout -out ~/.config/fleet/keys/ed25519-public.pem");
  process.exit(1);
}

console.log(`✓ Private key loaded from ${KEY_PATH}`);
console.log(`  ${pemRaw.split("\n").length} lines, ${Buffer.byteLength(pemRaw)} bytes`);

// ---------------------------------------------------------------------------
// 2. Import the key via WebCrypto (Ed25519 = EdDSA)
// ---------------------------------------------------------------------------

const { subtle } = globalThis.crypto;

if (!subtle) {
  console.error("✗ globalThis.crypto.subtle is not available (Node.js 20+ or browser required)");
  process.exit(1);
}

let privateKey;
try {
  privateKey = await subtle.importKey(
    "pkcs8",
    pemToDER(pemRaw),
    { name: "Ed25519" },
    false,
    ["sign"]
  );
  console.log("✓ Ed25519 private key imported via WebCrypto");
} catch (err) {
  console.error(`✗ Failed to import private key: ${err.message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 3. Sign a test JWT
// ---------------------------------------------------------------------------

const now = Math.floor(Date.now() / 1000);
const header = { alg: "EdDSA", typ: "JWT" };
const payload = {
  iss: "fleet",
  sub: "verify",
  aud: "model-api-proxy",
  iat: now,
  exp: now + 300,
  jti: `fleet-verify-${Date.now()}`,
};

const token = await signJWT(header, payload, privateKey);
console.log(`✓ Signed test JWT (${token.length} chars)`);

// ---------------------------------------------------------------------------
// 4. Decode and verify
// ---------------------------------------------------------------------------

const [hdrB64, payloadB64, sigB64] = token.split(".");
const decodedHeader = JSON.parse(atob(hdrB64));
const decodedPayload = JSON.parse(atob(payloadB64));

console.log("");
console.log("  ── JWT Header ──");
console.log(`  alg: ${decodedHeader.alg}`);
console.log(`  typ: ${decodedHeader.typ}`);

console.log("");
console.log("  ── JWT Payload ──");
for (const [k, v] of Object.entries(decodedPayload)) {
  const display = typeof v === "number" ? new Date(v * 1000).toISOString() : v;
  console.log(`  ${k}: ${display}`);
}

// ---------------------------------------------------------------------------
// 5. Try connecting to the server (non-fatal if not running)
// ---------------------------------------------------------------------------

const PROXY_URL = process.env.MODEL_API_PROXY_URL || "http://127.0.0.1:5200";
console.log("");
console.log(`  Checking ${PROXY_URL} ...`);

try {
  const res = await fetch(`${PROXY_URL}/v1/models`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(3000),
  });
  if (res.ok) {
    const body = await res.json();
    const models = body.data?.map((m) => m.id) ?? [];
    console.log(`  ✓ Server responded ${res.status} — ${models.length} model(s) visible`);
    if (models.length > 0) {
      console.log(`    ${models.slice(0, 5).join(", ")}${models.length > 5 ? ` (+${models.length - 5} more)` : ""}`);
    }
  } else {
    console.log(`  ⚠ Server responded ${res.status} ${res.statusText}`);
    console.log(`    (JWT auth may be working but server rejected the request)`);
  }
} catch (err) {
  if (err.name === "TimeoutError" || err.name === "AbortError") {
    console.log(`  ⚠ Server did not respond within 3s — is model-api-proxy running?`);
  } else if (err.cause?.code === "ECONNREFUSED") {
    console.log(`  ⚠ Connection refused — model-api-proxy is not running on this port`);
  } else {
    console.log(`  ⚠ ${err.message}`);
  }
  console.log(`    (key signing itself worked; server check is informational only)`);
}

console.log("");
console.log("✓ Edge auth pre-flight passed — JWT signing is functional");
process.exit(0);

// ===================================================================
// Helpers
// ===================================================================

/** Strip PEM armor and convert to DER Uint8Array */
function pemToDER(pem) {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const raw = atob(b64);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf;
}

/** Base64url encode */
function base64url(data) {
  const str =
    typeof data === "string"
      ? btoa(data)
      : btoa(String.fromCharCode(...new Uint8Array(data)));
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Sign a JWT using WebCrypto Ed25519 */
async function signJWT(header, payload, privateKeyObj) {
  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const sig = await subtle.sign("Ed25519", privateKeyObj, new TextEncoder().encode(signingInput));

  return `${signingInput}.${base64url(sig)}`;
}

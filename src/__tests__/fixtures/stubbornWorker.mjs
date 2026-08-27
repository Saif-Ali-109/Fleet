#!/usr/bin/env node
// Test fixture: long-lived fake worker that traps SIGTERM so the manager's
// WORKER_TIMEOUT_GRACE_MS SIGKILL fallback actually fires. Ignores stdin.
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);

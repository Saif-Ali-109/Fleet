#!/usr/bin/env node
// Test fixture: a long-lived fake worker. Ignores all argv and keeps the
// event loop alive so WORKER_TIMEOUT_MS kill switches actually fire.
setInterval(() => {}, 1000);

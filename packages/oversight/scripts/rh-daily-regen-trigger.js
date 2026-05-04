#!/usr/bin/env node
/**
 * daily-regen-trigger.js
 *
 * SessionStart hook. Fires daily-regen.js with --skip-if-today-done so that
 * the FIRST Claude Code session of each calendar day triggers a regen, and
 * subsequent sessions the same day are no-ops.
 *
 * The child process is spawned detached so it never blocks session start —
 * the regen runs in the background while Claude Code continues loading.
 *
 * This hook never blocks, never reads stdin (SessionStart is not a gate),
 * and always exits 0. It's paired with the Windows Task Scheduler ONLOGON
 * trigger so that Windows login and Claude Code session start both fire
 * the regen, but dedup on the same `daily-regen.last-run` marker.
 */

const { spawn } = require("child_process");
const path = require("path");

const SCRIPT = path.join(__dirname, "daily-regen.js");

try {
  const child = spawn("node", [SCRIPT, "--skip-if-today-done", "--quiet"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
} catch {
  // Never fail the session start — swallow any error.
}
process.exit(0);

#!/usr/bin/env node
/**
 * daily-regen-trigger.js
 *
 * SessionStart hook. Two responsibilities, both non-blocking:
 *
 *   1. (PRIMARY) Fire daily-regen.js with --skip-if-today-done so the FIRST
 *      Claude Code session of each calendar day triggers a regen, and
 *      subsequent same-day sessions are no-ops. The child is spawned
 *      detached so it never blocks session start.
 *
 *   2. (ADDED 2026-05-06) Probe supervisory-log freshness. If the log
 *      hasn't been written in >24h, emit `journal_staleness_alert` to
 *      oversight-events.jsonl so the next session sees the warning.
 *      See "Journal staleness probe" comment below for full rationale.
 *
 * Both responsibilities must be non-blocking — SessionStart is not a gate.
 * All errors are swallowed; this script always exits 0.
 *
 * Paired with the Windows Task Scheduler ONLOGON trigger so that Windows
 * login and Claude Code session start both fire the regen, but dedup on
 * the same `daily-regen.last-run` marker.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// ─── Journal staleness probes — config-driven (refactored 2026-05-08) ────
//
// ORIGINAL PROBLEM (2026-05-04 → 2026-05-07): supervisory log silently went
// 3 days without entries because hook-forwarder.js stop fell out of the Stop
// chain. Generalized lesson: any system journal can silently stop being
// written because something upstream was rewired. Each channel needs a
// liveness probe. Two probes shipped 2026-05-06 (supervisory-log + daily-regen
// marker). 2026-05-08 refactor: extract to lib/journal-probe.js + read
// channel manifest from ~/.claude/journals.json so adding a third probe is
// a config change, not a code change.
//
// CONSTRAINTS (preserved from original):
//   - Must NOT block session start; all errors swallowed.
//   - Idempotent: emits on every session start while a log is stale.
//     Downstream aggregation decides when to alert the user.
//   - Cold-start: missing files don't alert by default (alert_on_missing flag).
try {
  const { runProbes } = require("./lib/journal-probe");
  const { appendOversightEvent } = require("./lib/oversight-events");
  runProbes({ emit: (type, data) => appendOversightEvent(type, data) });
} catch {
  // Probe must never block session start; swallow any error.
}

// ─── Daily regen trigger (original responsibility) ────────────────────────

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

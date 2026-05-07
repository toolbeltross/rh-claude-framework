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

// ─── Journal staleness probe (added 2026-05-06) ──────────────────────────
//
// PROBLEM THIS CATCHES:
// On 2026-05-04 the Stop hook chain in ~/.claude/settings.json was
// rewritten and `hook-forwarder.js stop` (the only call site for
// appendProgressEntry) silently fell out of the chain. The supervisory
// log went 3 days without any new entries before the gap was noticed.
// Layer 3a was still firing, oversight-events.jsonl was still being
// written — only the human-readable journal channel went dark, and
// nothing monitored that channel for liveness.
//
// META-PATTERN: a system journal silently stops being written because
// something upstream was rewired. The fix in any one channel doesn't
// generalize — this probe generalizes the *detection* of any future
// occurrence in this channel. The supervisor explicitly framed this
// as the same shape as protocol-compliance theater: every individual
// rule is satisfied while the observable system output is broken.
//
// WHAT THE PROBE DOES:
//   - stat() the supervisory log
//   - if mtime is >24h ago, emit a journal_staleness_alert event
//   - if the log doesn't exist, do nothing (cold-start case — the first
//     hook-forwarder.js stop write will create it)
//
// CONSTRAINTS:
//   - Must NOT block session start. Wrapped in try/catch, all failures
//     swallowed. Worst case: the probe silently doesn't fire, and the
//     user discovers the gap manually like they did this time.
//   - Must NOT do meaningful I/O — one stat() and one appendFile() at
//     most.
//   - Idempotent: emits on every session start while the log is stale.
//     Don't dedupe here — let downstream tooling aggregate / decide
//     when to alert the user. Each event is cheap to write.
try {
  const SUPERVISORY_LOG = path.join(
    os.homedir(),
    ".claude",
    "telemetry-supervisory-log.md"
  );
  const STALENESS_MS = 24 * 60 * 60 * 1000;

  const stat = fs.statSync(SUPERVISORY_LOG, { throwIfNoEntry: false });
  if (stat) {
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > STALENESS_MS) {
      const { appendOversightEvent } = require("./lib/oversight-events");
      appendOversightEvent("journal_staleness_alert", {
        log_path: SUPERVISORY_LOG,
        last_mtime: new Date(stat.mtimeMs).toISOString(),
        age_hours: Math.round(ageMs / 3_600_000),
        threshold_hours: 24,
        note: "Supervisory log unwritten for >24h. Stop-hook progress logging may be broken — verify hook-forwarder.js stop is in the Stop hook chain.",
      });
    }
  }
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

#!/usr/bin/env node
/**
 * daily-regen.js
 *
 * Orchestrates the daily regeneration pipeline. Runs:
 *   1. generate-env-md.js         → writes ENVIRONMENT.md
 *   2. generate-state-md.js       → writes OVERSIGHT_STATE.md
 *   3. render-md-html.js (×3)     → writes 3 HTML files to Workspace root
 *
 * Each step is wrapped in try/catch so a failing step does not abort the rest.
 * Results (timestamp + per-step success/failure) are appended to daily-regen.log.
 *
 * Usage: node daily-regen.js [--quiet]
 *
 * Called by Windows Task Scheduler daily via the task "Claude Code Daily Regen".
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { config } = require('./lib/config');
const { withLock } = require('./lib/file-lock');

const SCRIPTS_DIR = path.join(config.claudeDir, "scripts");
const LOG_PATH = path.join(SCRIPTS_DIR, "daily-regen.log");
const LAST_RUN_MARKER = path.join(SCRIPTS_DIR, "daily-regen.last-run");
const RUN_LOCK = path.join(SCRIPTS_DIR, "daily-regen.run.lock");
const ATTEMPT_MARKER = path.join(SCRIPTS_DIR, "daily-regen.last-attempt");
// A non-success run leaves LAST_RUN_MARKER unset (see markRanToday), so without
// a second gate a persistently-failing step drives a full-pipeline rerun on
// EVERY trigger. This cooldown rate-limits trigger-fired reruns; the daily Task
// Scheduler run does not pass --skip-if-today-done, so it still force-runs.
const RERUN_COOLDOWN_MS = 60 * 60 * 1000; // 60 min
const QUIET = process.argv.includes("--quiet");
const SKIP_IF_DONE = process.argv.includes("--skip-if-today-done");

function todayStamp() {
  return new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD, local time
}
function alreadyRanToday() {
  try {
    return fs.readFileSync(LAST_RUN_MARKER, "utf8").trim() === todayStamp();
  } catch { return false; }
}
function markRanToday() {
  // Cross-process lock — two SessionStart-triggered regens racing on this
  // marker would both pass the alreadyRanToday check and double-run.
  try {
    withLock(LAST_RUN_MARKER, () => {
      fs.writeFileSync(LAST_RUN_MARKER, todayStamp(), "utf8");
    });
  } catch { /* ignore */ }
}

function recentlyAttempted() {
  try {
    const ts = Date.parse(fs.readFileSync(ATTEMPT_MARKER, "utf8").trim());
    return Number.isFinite(ts) && (Date.now() - ts) < RERUN_COOLDOWN_MS;
  } catch { return false; }
}
function markAttempt() {
  try { fs.writeFileSync(ATTEMPT_MARKER, new Date().toISOString(), "utf8"); } catch { /* ignore */ }
}

// ───────────────────────── Single-run guard ─────────────────────────
// Cross-process lock so concurrent SessionStart triggers don't each run the
// full pipeline. The 2026-06-19 incident: ~20 near-simultaneous triggers each
// ran all 15 steps, and each dispatched the rh-daily-guidance `--agent` worker
// before the per-day digest existed → ~30 headless agents (each a dashboard
// tab). file-lock.js withLock is deliberately NOT reused here: its 5s
// time-based staleness would let a second trigger steal the lock mid-pipeline
// (a run takes minutes). Staleness is instead keyed on holder-PID liveness.
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }  // signal 0 = existence probe (sends nothing)
  catch (e) { return e.code === "EPERM"; }      // exists but not signalable by us → alive
}
function readLockPid() {
  try { return parseInt(fs.readFileSync(RUN_LOCK, "utf8").split("\n")[0], 10) || 0; }
  catch { return 0; }
}
function acquireRunLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(RUN_LOCK, "wx");    // O_CREAT | O_EXCL — atomic create-or-fail
      fs.writeSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== "EEXIST") return false;      // unexpected FS error — do not run
      if (pidAlive(readLockPid())) return false;  // another run is genuinely in progress
      try { fs.unlinkSync(RUN_LOCK); } catch { /* race: another reclaimer won */ }
      // loop once to re-create the lock we just reclaimed
    }
  }
  return false;
}
function releaseRunLock() {
  // Only unlink if we still own it (guards against a stale-reclaim race).
  try { if (readLockPid() === process.pid) fs.unlinkSync(RUN_LOCK); } catch { /* already gone */ }
}

// ───────────────────────── Step definitions ─────────────────────────

// Phase 1 C2 follow-on (2026-05-02): script references updated to rh- prefix
// after the 2026-05-01 mass rename pass missed this STEPS array. Pre-fix the
// pipeline had been silently failing render+audit+self-test steps for ~24h.
const STEPS = [
  {
    name: "rh-generate-env-md",
    cmd: "node",
    args: [path.join(SCRIPTS_DIR, "rh-generate-env-md.js")],
  },
  {
    name: "rh-generate-state-md",
    cmd: "node",
    args: [path.join(SCRIPTS_DIR, "rh-generate-state-md.js")],
  },
  {
    name: "render-env-html",
    cmd: "node",
    args: [
      path.join(SCRIPTS_DIR, "rh-render-md-html.js"),
      "--in", path.join(config.oversightDir, "..", "environment", "ENVIRONMENT.md"),
      "--out", path.join(config.workspace, "ENVIRONMENT.html"),
      "--title", `Claude Code Environment — ${config.userName}`,
    ],
  },
  {
    name: "render-state-html",
    cmd: "node",
    args: [
      path.join(SCRIPTS_DIR, "rh-render-md-html.js"),
      "--in", path.join(config.oversightDir, "OVERSIGHT_STATE.md"),
      "--out", path.join(config.workspace, "OVERSIGHT_STATE.html"),
      "--title", "Oversight System — Current State",
    ],
  },
  {
    // OVERSIGHT_SYSTEM.md is hand-authored and rarely changes — only re-render when source is newer than output.
    name: "render-system-html",
    cmd: "node",
    args: [
      path.join(SCRIPTS_DIR, "rh-render-md-html.js"),
      "--in", path.join(config.oversightDir, "OVERSIGHT_SYSTEM.md"),
      "--out", path.join(config.workspace, "OVERSIGHT_SYSTEM.html"),
      "--title", "Oversight System — Design Spec",
      "--skip-if-unchanged",
    ],
  },
  {
    // Transcript FTS ingestion (flag-gated: the script itself no-ops unless
    // oversight.json scribeDb:true). Incremental — only new bytes per session.
    // timeoutOverrideMs: the incremental pass spawns one psql.exe per transcript
    // file (offset SELECT) even for up-to-date files, before the new-bytes check.
    // Windows psql cold-start is ~147ms/spawn, so the read-only floor scales with
    // file count: ~56s at 380 files (measured 2026-06-15), which exceeds the 60s
    // default and killed the step at 60043ms (exit code null). 6min matches the
    // learning-loop precedent and gives headroom (~2400 files) until the per-file
    // SELECTs are batched into a single query (durable fix; tracked).
    name: "rh-transcript-ingest",
    cmd: "node",
    args: [path.join(SCRIPTS_DIR, "rh-transcript-ingest.js")],
    timeoutOverrideMs: 6 * 60_000,
  },
  {
    // Oversight-log FTS ingestion (same scribeDb flag gate, incremental).
    name: "rh-ingest-logs",
    cmd: "node",
    args: [path.join(SCRIPTS_DIR, "rh-ingest-logs.js")],
  },
  {
    // Fetches Anthropic Claude Code / SDK doc pages, diffs against cached hashes,
    // writes environment/GUIDANCE_CHANGES.md when drift is detected. Runs last so
    // transient network errors don't block the core regen steps.
    name: "rh-check-anthropic-guidance",
    cmd: "node",
    args: [path.join(SCRIPTS_DIR, "rh-check-anthropic-guidance.js")],
  },
  {
    // Hook latency regression detection + JSONL rotation.
    name: "hook-perf-audit",
    cmd: "node",
    args: [path.join(SCRIPTS_DIR, "lib", "hook-perf-audit.js")],
  },
  {
    // F-04: daily smoke test of oversight enforcement hooks. Runs synthetic
    // fixtures through the hooks and confirms expected behavior. Catches
    // silent regressions of the oversight system itself (LE-22 follow-on).
    name: "rh-oversight-self-test",
    cmd: "node",
    args: [path.join(SCRIPTS_DIR, "rh-oversight-self-test.js")],
  },
  {
    // Phase 4 D2/D3 (2026-05-02): daily aggregation of oversight events into
    // supervisor-curated proposals. Has its own same-day guard (20h) and
    // dedup against existing open `session=learning-loop` rows in
    // recommendations.md (Option B). If no new groups cross threshold, no
    // supervisor dispatch occurs (zero LLM cost on quiet days). Runs last
    // so a long supervisor dispatch doesn't delay the core pipeline.
    name: "rh-learning-loop",
    cmd: "node",
    args: [path.join(SCRIPTS_DIR, "rh-learning-loop.js")],
    timeoutOverrideMs: 6 * 60_000,  // supervisor dispatch can take up to 5min
  },
  {
    // P3-1: daily refresh of the cross-session supervisor-trends doc. Aggregates
    // the last 7 days of oversight-events.jsonl + supervisory-log.md rejections
    // into ~/.claude/memory-shared/supervisor-trends.md. Lightweight (aggregation
    // only, no LLM dispatch) so it can sit inside the core pipeline. Runs after
    // learning-loop (which may add events) and before auto-prune. Previously this
    // doc only refreshed on manual `rh-oversight supervisor-sweep` invocation.
    name: "rh-supervisor-sweep",
    cmd: "node",
    args: [path.join(SCRIPTS_DIR, "rh-supervisor-sweep.js")],
  },
  {
    // P1-5 (2026-05-08): daily ephemeral-artifact and aged-scribe-row pruning.
    // Caps settings.json backups at 5 (matches Anthropic's policy). Deletes
    // flag files >24h old. Archives resolved scribe rows >14d. Emits
    // scribe_row_review_needed for open >30d. Runs after learning-loop so
    // supervisor-curated rows added that day aren't archived immediately.
    name: "rh-auto-prune",
    cmd: "node",
    args: [path.join(SCRIPTS_DIR, "rh-auto-prune.js"), "--apply"],
  },
  {
    // PLAN-2026-06-15 (F-K): propose-only daily triage of the open scribe
    // backlog. Reads OPEN rows from the canonical md files, dispatches
    // rh-supervisor (scope=scribe-triage) for a per-row disposition proposal,
    // writes ONLY proposed_* columns (never status). Same-day guard + batch
    // cap + dedup; SKIPs cleanly when no untriaged rows remain. Runs LAST,
    // after auto-prune, so it triages only surviving open rows. The user
    // applies dispositions via the /scribe UI (propose-only invariant).
    name: "rh-scribe-triage",
    cmd: "node",
    args: [path.join(SCRIPTS_DIR, "rh-scribe-triage.js")],
    timeoutOverrideMs: 6 * 60_000,  // supervisor dispatch can take up to 5min
  },
  {
    // PLAN-2026-06-15: automated daily guidance + health digest (fully
    // headless, no manual paste). Pre-computes local checks in Node (no Bash
    // for the LLM) and dispatches the rh-daily-guidance agent (WebFetch/
    // WebSearch/Read/Write/Glob — Bash absent; writes bounded to cowork/ by the
    // agent). Idempotent (SKIPs if today's cowork/daily-digest-<date>.md
    // exists). Steward APPROVE-WITH-CONDITIONS C1-C4. Runs LAST — heaviest LLM
    // step, and it references the local checks the earlier steps produced.
    name: "rh-daily-guidance",
    cmd: "node",
    args: [path.join(SCRIPTS_DIR, "rh-daily-guidance.js")],
    timeoutOverrideMs: 9 * 60_000,  // web acquisition + synthesis (8min dispatch + headroom)
  },
];

// ───────────────────────── Runner ─────────────────────────

function runStep(step) {
  const start = Date.now();
  try {
    const res = spawnSync(step.cmd, step.args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: step.timeoutOverrideMs || 60_000,
    });
    const ms = Date.now() - start;
    if (res.status === 0) {
      return { name: step.name, ok: true, ms, stdout: (res.stdout || "").trim(), stderr: "" };
    }
    return {
      name: step.name,
      ok: false,
      ms,
      stdout: (res.stdout || "").trim(),
      stderr: (res.stderr || "").trim() || `exit code ${res.status}`,
    };
  } catch (e) {
    return { name: step.name, ok: false, ms: Date.now() - start, stdout: "", stderr: e.message };
  }
}

// Detect whether a step intentionally skipped its work (vs ran to completion).
// Two valid forms:
//   1. Structured: last non-empty line of stdout is JSON containing `skipped`
//      truthy, OR `reason` field matching a known skip-reason string
//      (rh-learning-loop.js outputs this shape).
//   2. Plain text: stdout begins (after optional whitespace) with "Skipped:"
//      (rh-render-md-html.js --skip-if-unchanged outputs this shape).
//
// Substring-matching `/skipped/i` against raw stdout is too lenient — it
// false-positives when child output (e.g., supervisor dispatch text) contains
// the word "skipped" anywhere. Verified false-positive 2026-05-02 on
// rh-learning-loop's first real fire (217s of legitimate work mislabeled SKIP).
const SKIP_REASONS = new Set([
  'same-day-guard',
  'no-threshold-crossings',
  'all-groups-already-proposed',
  'no-untriaged-rows',
]);
function wasIntentionallySkipped(stdout) {
  const trimmed = (stdout || '').trim();
  if (!trimmed) return false;
  // Form 2: plain text "Skipped:" at start
  if (/^\s*Skipped\b/m.test(trimmed.split('\n')[0])) return true;
  // Form 1: last line is JSON with skipped field or known skip-reason
  const lastLine = trimmed.split('\n').pop().trim();
  if (lastLine.startsWith('{') && lastLine.endsWith('}')) {
    try {
      const j = JSON.parse(lastLine);
      if (j.skipped) return true;
      if (typeof j.reason === 'string' && SKIP_REASONS.has(j.reason)) return true;
    } catch { /* not JSON, fall through */ }
  }
  return false;
}

function log(line) {
  if (!QUIET) console.log(line);
  try {
    // JSONL atomic-append assumption (Phase 1 C3, 2026-05-02): unlocked;
    // single-process daily-regen produces single-line log entries well under
    // 4KB. Multi-process not expected (only the SessionStart trigger spawns
    // it, with a same-day guard).
    fs.appendFileSync(LOG_PATH, line + "\n", "utf8");
  } catch { /* ignore log write failures */ }
}

// ───────────────────────── Main ─────────────────────────

function main() {
  // Called from a trigger (SessionStart hook or ONLOGON task): skip if today's
  // run already succeeded, OR if a run was attempted within the rerun cooldown
  // (so a persistently-failing step can't drive a full-pipeline rerun on every
  // SessionStart). The daily Task Scheduler run omits --skip-if-today-done and
  // therefore bypasses both gates.
  if (SKIP_IF_DONE) {
    const ranToday = alreadyRanToday();
    if (ranToday || recentlyAttempted()) {
      const why = ranToday
        ? `already ran for ${todayStamp()}`
        : `attempted within the last ${Math.round(RERUN_COOLDOWN_MS / 60000)} min`;
      log(`\n==== daily-regen skipped ${new Date().toISOString()} — ${why} ====`);
      process.exit(0);
    }
  }

  // Single-run guard: if another daily-regen is mid-pipeline, don't pile on.
  // This is the primary fix for the concurrent-run storm.
  if (!acquireRunLock()) {
    log(`\n==== daily-regen skipped ${new Date().toISOString()} — another run in progress ====`);
    process.exit(0);
  }

  let failCount = 0;
  try {
    markAttempt();
    const startTs = new Date().toISOString();
    log(`\n==== daily-regen run ${startTs} ====`);

    const results = [];
    for (const step of STEPS) {
      const r = runStep(step);
      results.push(r);
      let status = r.ok ? "OK  " : "FAIL";
      if (r.ok && wasIntentionallySkipped(r.stdout)) status = "SKIP";
      log(`[${status}] ${r.name.padEnd(22)} ${r.ms.toString().padStart(5)} ms`);
      if (!r.ok && r.stderr) {
        log(`       stderr: ${r.stderr.split("\n")[0].slice(0, 200)}`);
      }
    }

    const okCount = results.filter(r => r.ok).length;
    failCount = results.length - okCount;
    const endTs = new Date().toISOString();
    log(`==== completed ${endTs} — ${okCount}/${results.length} ok, ${failCount} failed ====`);

    // Only mark "done for today" on fully successful runs — a partial failure
    // should be retried, but RERUN_COOLDOWN_MS rate-limits that so a
    // persistently-failing step can't drive a rerun storm.
    if (failCount === 0) markRanToday();
  } finally {
    releaseRunLock();
  }

  process.exit(failCount === 0 ? 0 : 2);
}

main();

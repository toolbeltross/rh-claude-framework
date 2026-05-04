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

const SCRIPTS_DIR = path.join(config.claudeDir, "scripts");
const LOG_PATH = path.join(SCRIPTS_DIR, "daily-regen.log");
const LAST_RUN_MARKER = path.join(SCRIPTS_DIR, "daily-regen.last-run");
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
  try { fs.writeFileSync(LAST_RUN_MARKER, todayStamp(), "utf8"); } catch { /* ignore */ }
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
  if (SKIP_IF_DONE && alreadyRanToday()) {
    // Called from a trigger (SessionStart hook or ONLOGON task) and already ran today — silently exit.
    log(`\n==== daily-regen skipped ${new Date().toISOString()} — already ran for ${todayStamp()} ====`);
    process.exit(0);
  }

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
  const failCount = results.length - okCount;
  const endTs = new Date().toISOString();
  log(`==== completed ${endTs} — ${okCount}/${results.length} ok, ${failCount} failed ====`);

  // Only mark "done for today" on fully successful runs — a partial failure should be retried on the next trigger.
  if (failCount === 0) markRanToday();

  process.exit(failCount === 0 ? 0 : 2);
}

main();

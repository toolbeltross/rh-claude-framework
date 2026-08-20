#!/usr/bin/env node
/**
 * rh-daily-validate.js
 *
 * SessionStart hook — "daily config gate", runs on the FIRST Claude Code
 * session of each calendar day. An ATOMIC per-day claim (exclusive-create
 * lockfile) dedups subsequent AND concurrent sessions — the harness can fire
 * SessionStart several times within milliseconds (observed 2026-06-07: 3
 * invocations within 54ms), and a plain check-then-write marker raced, letting
 * all three run. The exclusive create ('wx') ensures exactly one runs per day.
 *
 * Validates that the oversight config is correct + telemetry is reachable,
 * appends a verdict row to ~/.claude/validation-log.jsonl, and injects a
 * one-line verdict as SessionStart additionalContext so the user sees it.
 *
 * Checks (all fast; the 2 bash-spawn stress tests are intentionally excluded
 * per oversight-validation-build.md — they're environment-flaky on this PC):
 *   1. rh-oversight self-test  (HARD gate: exit 0 expected)
 *   2. rh-oversight health     (record exit: 0 ok / 1 degraded / 2 critical)
 *   3. settings.json parses as valid JSON and contains a hooks object
 *   4. hook-perf latency: max durationMs in last 24h < 1000
 *
 * Philosophy (mirrors rh-daily-regen-trigger.js): never hard-fail session
 * start. Errors are swallowed; always exit 0. The gate runs at most once/day
 * and only blocks the first session briefly (execSync timeouts bound it).
 *
 * Can also be run standalone for verification: `node rh-daily-validate.js`
 * (no stdin) — runs the gate, writes the log row, prints the verdict.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");

const CLAUDE = path.join(os.homedir(), ".claude");
const MARKER = path.join(CLAUDE, "daily-validate.last-run");
const claimPath = (day) => path.join(CLAUDE, `daily-validate.${day}.ran`);
const LOG = path.join(CLAUDE, "validation-log.jsonl");
const SETTINGS = path.join(CLAUDE, "settings.json");
const HOOK_PERF = path.join(CLAUDE, "hook-perf.jsonl");

function today() {
  // local calendar day YYYY-MM-DD
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
// Atomic once-per-day claim. fs.openSync(..., 'wx') is an exclusive create:
// it succeeds for exactly one caller and throws EEXIST for the rest, atomically
// at the OS level. The filename is day-scoped, so it self-resets each calendar
// day. Returns true only for the single process that wins today's claim (and
// should therefore run the gate). Replaces the old read-then-write `ranToday()`,
// whose check-then-act gap let concurrent SessionStart invocations all run.
function claimToday() {
  const day = today();
  try {
    const fd = fs.openSync(claimPath(day), "wx");
    try { fs.writeSync(fd, new Date().toISOString()); } finally { fs.closeSync(fd); }
    // Won today: tidy prior days' claim files so they don't accumulate.
    try {
      for (const f of fs.readdirSync(CLAUDE)) {
        if (/^daily-validate\..+\.ran$/.test(f) && f !== `daily-validate.${day}.ran`) {
          try { fs.unlinkSync(path.join(CLAUDE, f)); } catch {}
        }
      }
    } catch {}
    return true;
  } catch {
    // EEXIST (already claimed today) or any other error → skip. Erring toward
    // skip preserves "at most once/day" rather than risking a duplicate run.
    return false;
  }
}

// Resolve the framework CLI through the shared candidate chain (@rh/shared/
// framework.js), which rh-fw.js and rh-config-integrity.js also import: prefer
// oversight.json's workspace, then the post-2026-07-27 non-synced root, then the
// legacy cloud-sync roots, so an empty/partial oversight.json (observed
// 2026-06-06 — init wrote {}) doesn't break the gate. The CLI entry point is
// itself the validity probe, so a checkout that lacks it is correctly skipped.
function cliPath() {
  let framework;
  try {
    framework = require("./lib/framework");
  } catch {
    return null;                          // resolver absent — treat as no CLI
  }
  return framework.resolveFrameworkPath(
    path.join("packages", "cli", "bin", "rh-oversight.js")
  );
}

// Run a node CLI subcommand; return {exit, ok}. exit captured even on non-zero.
function runCli(cli, sub, timeoutMs) {
  try {
    execSync(`node "${cli}" ${sub}`, { timeout: timeoutMs, stdio: "ignore" });
    return { exit: 0, ok: true };
  } catch (e) {
    return { exit: typeof e.status === "number" ? e.status : -1, ok: false };
  }
}

function checkSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
    return s && typeof s === "object" && s.hooks && typeof s.hooks === "object";
  } catch { return false; }
}

function maxHookLatency24h() {
  try {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    let max = 0;
    for (const line of fs.readFileSync(HOOK_PERF, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      const ts = Date.parse(r.ts);
      if (Number.isFinite(ts) && ts >= cutoff && typeof r.durationMs === "number") {
        if (r.durationMs > max) max = r.durationMs;
      }
    }
    return max; // 0 if no records
  } catch { return null; }
}

function runGate() {
  const cli = cliPath();
  const selfTest = cli ? runCli(cli, "self-test", 60000) : { exit: -1, ok: false };
  const health = cli ? runCli(cli, "health", 60000) : { exit: -1, ok: false };
  const settingsOk = checkSettings();
  const maxLat = maxHookLatency24h();

  const pass =
    selfTest.ok &&                       // self-test must exit 0
    settingsOk &&                        // settings valid
    health.exit !== 2 &&                 // health not critical (degraded=1 tolerated)
    (maxLat === null || maxLat < 1000);  // latency budget (null = no data yet)

  return {
    ts: new Date().toISOString(),
    day: today(),
    verdict: pass ? "PASS" : "FAIL",
    selfTest: selfTest.exit,
    health: health.exit,
    settingsValid: settingsOk,
    maxHookLatencyMs: maxLat,
    cliFound: !!cli,
  };
}

function emit(result) {
  const degraded = result.health === 1;
  let msg = `## Daily config gate — ${result.verdict}`;
  msg += `\nself-test exit=${result.selfTest} · health exit=${result.health}` +
    `${degraded ? " (degraded)" : ""} · settings ${result.settingsValid ? "valid" : "INVALID"}` +
    `${result.maxHookLatencyMs === null ? "" : ` · max hook latency ${result.maxHookLatencyMs}ms`}`;
  if (result.verdict === "FAIL") {
    msg += `\n⚠ Oversight config gate FAILED on first session today — review ~/.claude/validation-log.jsonl before relying on enforcement.`;
  }
  return msg;
}

function main() {
  // SessionStart hooks receive JSON on stdin; we don't need it, but drain it.
  // (When run standalone there is no stdin — that's fine.)
  let result;
  if (!claimToday()) {
    // Another invocation already claimed today (or claim unavailable) — no-op,
    // no context noise.
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "" },
    }));
    return;
  }
  try {
    result = runGate();
    try { fs.appendFileSync(LOG, JSON.stringify(result) + "\n"); } catch {}
    try { fs.writeFileSync(MARKER, result.day); } catch {}
  } catch (e) {
    result = { ts: new Date().toISOString(), day: today(), verdict: "ERROR", error: String(e && e.message) };
    try { fs.appendFileSync(LOG, JSON.stringify(result) + "\n"); } catch {}
  }
  const additionalContext = emit(result);
  // When run as a hook: emit JSON. When run standalone: also print human verdict to stderr.
  if (process.stdout.isTTY) {
    process.stderr.write(additionalContext + "\n");
  }
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext },
  }));
}

main();

// Tests for rh-daily-regen.js — daily pipeline orchestrator.
//
// Two test tiers:
//   1. Inline unit tests for wasIntentionallySkipped() — zero network, zero I/O.
//      The function is NOT exported, so we copy it verbatim here. Any deviation
//      from the source is a test-maintenance bug, not a production bug.
//   2. Spawn tests for the --skip-if-today-done guard (alreadyRanToday +
//      markRanToday). All real pipeline steps fail in a tmp HOME (scripts are
//      absent), which is the expected test-env behavior.

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'rh-daily-regen.js');

// ─── Verbatim copy of wasIntentionallySkipped from rh-daily-regen.js ──────────
// Keep this in sync with the source. Tests below confirm the documented contract.

const SKIP_REASONS = new Set([
  'same-day-guard',
  'no-threshold-crossings',
  'all-groups-already-proposed',
]);

function wasIntentionallySkipped(stdout) {
  const trimmed = (stdout || '').trim();
  if (!trimmed) return false;
  // Form 2: plain text "Skipped:" at start of first line
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

// ─── Spawn helpers ────────────────────────────────────────────────────────────

function withTmpEnv(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-daily-regen-test-'));
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(path.join(claudeDir, 'scripts'), { recursive: true });
  try { return fn({ home, claudeDir }); }
  finally { fs.rmSync(home, { recursive: true, force: true }); }
}

function runScript({ home, claudeDir }, args = []) {
  return spawnSync('node', [SCRIPT, '--quiet', ...args], {
    encoding: 'utf8',
    timeout: 15000,   // all steps fail quickly (scripts absent in tmp), 15s generous
    windowsHide: true,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CLAUDE_DIR: claudeDir,
      CLAUDE_WORKSPACE: home,
    },
  });
}

// ─── wasIntentionallySkipped unit tests ──────────────────────────────────────

const tests = [
  {
    name: 'wasIntentionallySkipped: empty string → false',
    fn: () => assert.strictEqual(wasIntentionallySkipped(''), false),
  },
  {
    name: 'wasIntentionallySkipped: whitespace-only → false',
    fn: () => assert.strictEqual(wasIntentionallySkipped('   \n  '), false),
  },
  {
    name: 'wasIntentionallySkipped: "Skipped: same-day guard" (Form 2) → true',
    fn: () => assert.strictEqual(wasIntentionallySkipped('Skipped: same-day guard'), true),
  },
  {
    name: 'wasIntentionallySkipped: "Skipped:" at start of first line → true',
    fn: () => assert.strictEqual(
      wasIntentionallySkipped('Skipped: whatever reason\nextra output'), true),
  },
  {
    name: 'wasIntentionallySkipped: "skipped" mid-content only, not at line start → false',
    fn: () => assert.strictEqual(
      wasIntentionallySkipped('Running step: skipped some tasks\ndone'), false,
    ),
  },
  {
    name: 'wasIntentionallySkipped: JSON last line {skipped: true} (Form 1) → true',
    fn: () => assert.strictEqual(
      wasIntentionallySkipped('some output\n{"skipped":true}'), true),
  },
  {
    name: 'wasIntentionallySkipped: JSON {skipped: false} → false',
    fn: () => assert.strictEqual(
      wasIntentionallySkipped('some output\n{"skipped":false}'), false),
  },
  {
    name: 'wasIntentionallySkipped: JSON {reason: "same-day-guard"} → true',
    fn: () => assert.strictEqual(
      wasIntentionallySkipped('{"reason":"same-day-guard"}'), true),
  },
  {
    name: 'wasIntentionallySkipped: JSON {reason: "no-threshold-crossings"} → true',
    fn: () => assert.strictEqual(
      wasIntentionallySkipped('{"reason":"no-threshold-crossings"}'), true),
  },
  {
    name: 'wasIntentionallySkipped: JSON {reason: "all-groups-already-proposed"} → true',
    fn: () => assert.strictEqual(
      wasIntentionallySkipped('{"reason":"all-groups-already-proposed"}'), true),
  },
  {
    name: 'wasIntentionallySkipped: JSON {reason: "unknown-reason"} → false',
    fn: () => assert.strictEqual(
      wasIntentionallySkipped('{"reason":"unknown-reason"}'), false),
  },
  {
    name: 'wasIntentionallySkipped: non-JSON last line → false',
    fn: () => assert.strictEqual(
      wasIntentionallySkipped('multi\nline\nnot json at all'), false),
  },

  // ─── STEPS wiring (P3-1: supervisor-sweep in the daily pipeline) ────────────

  {
    name: 'STEPS includes rh-supervisor-sweep step invoking rh-supervisor-sweep.js',
    fn: () => {
      const src = fs.readFileSync(SCRIPT, 'utf8');
      assert.ok(/name:\s*["']rh-supervisor-sweep["']/.test(src),
        'STEPS must declare a rh-supervisor-sweep step');
      assert.ok(/rh-supervisor-sweep\.js/.test(src),
        'sweep step must invoke rh-supervisor-sweep.js');
    },
  },
  {
    name: 'rh-supervisor-sweep runs after rh-learning-loop and before rh-auto-prune',
    fn: () => {
      const src = fs.readFileSync(SCRIPT, 'utf8');
      const iLearning = src.indexOf('"rh-learning-loop"');
      const iSweep = src.indexOf('"rh-supervisor-sweep"');
      const iPrune = src.indexOf('"rh-auto-prune"');
      assert.ok(iLearning !== -1 && iSweep !== -1 && iPrune !== -1,
        'all three step names must be present');
      assert.ok(iLearning < iSweep && iSweep < iPrune,
        `expected order learning-loop < supervisor-sweep < auto-prune, got ${iLearning}/${iSweep}/${iPrune}`);
    },
  },

  // ─── Spawn: --skip-if-today-done guard ─────────────────────────────────────

  {
    name: '--skip-if-today-done with today\'s marker → exits 0 (skipped)',
    fn: () => withTmpEnv((env) => {
      // Seed the last-run marker with today's ISO date (sv-SE locale format)
      const today = new Date().toLocaleDateString('sv-SE');
      const markerPath = path.join(env.claudeDir, 'scripts', 'daily-regen.last-run');
      fs.writeFileSync(markerPath, today, 'utf8');

      const r = runScript(env, ['--skip-if-today-done']);
      assert.strictEqual(r.status, 0,
        `should exit 0 when already ran today; stderr: ${r.stderr?.slice(0, 200)}`);
    }),
  },
  {
    name: '--skip-if-today-done with no marker → runs pipeline (exits 2 in tmp env)',
    fn: () => withTmpEnv((env) => {
      // No marker file → alreadyRanToday() returns false → pipeline runs.
      // All steps fail (scripts absent) → exit code 2.
      const r = runScript(env, ['--skip-if-today-done']);
      assert.strictEqual(r.status, 2,
        `should exit 2 when pipeline steps all fail in tmp env; stderr: ${r.stderr?.slice(0, 200)}`);
    }),
  },

  // ─── Runtime integration: the sweep step actually executes in sequence ──────
  // Stronger than the source-text structural tests above: this runs the real
  // pipeline and asserts the per-step log shows rh-supervisor-sweep being
  // attempted between learning-loop and auto-prune. Steps fail (scripts absent
  // in tmp HOME) but each is still attempted + logged, which is what proves the
  // runner traverses to the step at runtime.
  {
    name: 'pipeline run logs rh-supervisor-sweep between learning-loop and auto-prune',
    fn: () => withTmpEnv((env) => {
      runScript(env);   // full pipeline, --quiet (still writes daily-regen.log)
      const logPath = path.join(env.claudeDir, 'scripts', 'daily-regen.log');
      const logText = fs.readFileSync(logPath, 'utf8');
      const iLearning = logText.indexOf('rh-learning-loop');
      const iSweep = logText.indexOf('rh-supervisor-sweep');
      const iPrune = logText.indexOf('rh-auto-prune');
      assert.ok(iSweep !== -1,
        `daily-regen.log must show the rh-supervisor-sweep step ran; log:\n${logText}`);
      assert.ok(iLearning !== -1 && iPrune !== -1,
        'log must show learning-loop and auto-prune steps');
      assert.ok(iLearning < iSweep && iSweep < iPrune,
        `runtime order must be learning-loop < supervisor-sweep < auto-prune; got ${iLearning}/${iSweep}/${iPrune}`);
    }),
  },

  // ─── Single-run guard (run-lock) — concurrent-storm fix (2026-06-19) ─────────

  {
    name: 'run-lock held by a LIVE pid → skips (exit 0, "another run in progress")',
    fn: () => withTmpEnv((env) => {
      // Seed the lock with this test process's own pid — guaranteed alive.
      const lockPath = path.join(env.claudeDir, 'scripts', 'daily-regen.run.lock');
      fs.writeFileSync(lockPath, `${process.pid}\n${new Date().toISOString()}\n`, 'utf8');
      const r = runScript(env);   // no --skip flag: would otherwise force-run all steps
      assert.strictEqual(r.status, 0,
        `should skip while a live run-lock is held; stderr: ${r.stderr?.slice(0, 200)}`);
      const logText = fs.readFileSync(path.join(env.claudeDir, 'scripts', 'daily-regen.log'), 'utf8');
      assert.ok(/another run in progress/.test(logText),
        `log must record the concurrent-skip; log:\n${logText}`);
      // The live holder's lock must be left intact (not stolen).
      assert.ok(fs.existsSync(lockPath), 'live holder lock must not be removed');
    }),
  },
  {
    name: 'run-lock held by a DEAD pid → reclaims stale lock and runs (exit 2 in tmp)',
    fn: () => withTmpEnv((env) => {
      // spawnSync is synchronous: by the time it returns, the child has exited,
      // so its pid is dead. If the OS recycled it (alive), this asserts loudly
      // (would skip → exit 0) rather than passing silently.
      const deadPid = spawnSync('node', ['-e', 'process.exit(0)']).pid;
      const lockPath = path.join(env.claudeDir, 'scripts', 'daily-regen.run.lock');
      fs.writeFileSync(lockPath, `${deadPid}\n${new Date(0).toISOString()}\n`, 'utf8');
      const r = runScript(env);   // should reclaim and run; steps fail in tmp → exit 2
      assert.strictEqual(r.status, 2,
        `should reclaim a dead-pid lock and run; stderr: ${r.stderr?.slice(0, 200)}`);
    }),
  },

  // ─── Rerun cooldown — bounds trigger-fired reruns after a non-success ────────

  {
    name: '--skip-if-today-done with a RECENT last-attempt → skips (exit 0, cooldown)',
    fn: () => withTmpEnv((env) => {
      // No last-run marker, but a fresh attempt timestamp → cooldown gate fires.
      const attemptPath = path.join(env.claudeDir, 'scripts', 'daily-regen.last-attempt');
      fs.writeFileSync(attemptPath, new Date().toISOString(), 'utf8');
      const r = runScript(env, ['--skip-if-today-done']);
      assert.strictEqual(r.status, 0,
        `should skip within the rerun cooldown; stderr: ${r.stderr?.slice(0, 200)}`);
    }),
  },
  {
    name: '--skip-if-today-done with an OLD last-attempt → runs (exit 2 in tmp)',
    fn: () => withTmpEnv((env) => {
      const attemptPath = path.join(env.claudeDir, 'scripts', 'daily-regen.last-attempt');
      fs.writeFileSync(attemptPath, new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), 'utf8');
      const r = runScript(env, ['--skip-if-today-done']);
      assert.strictEqual(r.status, 2,
        `should run once the cooldown has elapsed; stderr: ${r.stderr?.slice(0, 200)}`);
    }),
  },
];

module.exports = { tests };

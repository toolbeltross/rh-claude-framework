// Unit tests for rh-daily-regen-trigger.js — SessionStart hook with two
// responsibilities (both non-blocking):
//   1. Spawn daily-regen.js --skip-if-today-done detached
//   2. Run journal-staleness probes (emit oversight events on stale logs)
//
// Non-blocking contract: must always exit 0 in <2s regardless of probe
// outcome or spawn failure. All errors swallowed.

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'rh-daily-regen-trigger.js');

function withTmpEnv(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-drt-test-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  try { return fn({ home, claudeDir: path.join(home, '.claude') }); }
  finally { fs.rmSync(home, { recursive: true, force: true }); }
}

function runTrigger(env) {
  const t0 = Date.now();
  const r = spawnSync('node', [SCRIPT], {
    encoding: 'utf8', timeout: 5000, windowsHide: true,
    env: {
      ...process.env,
      HOME: env.home, USERPROFILE: env.home,
      CLAUDE_DIR: env.claudeDir,
      CLAUDE_WORKSPACE: env.home,
    },
    input: JSON.stringify({ session_id: 'test-session' }),
  });
  return { exitCode: r.status, stdout: r.stdout || '', stderr: r.stderr || '', durationMs: Date.now() - t0 };
}

const tests = [
  {
    name: 'exits 0 in empty tmp HOME (no journals.json, no log files)',
    fn: () => withTmpEnv((env) => {
      const r = runTrigger(env);
      assert.strictEqual(r.exitCode, 0, `should always exit 0 (non-blocking); stderr: ${r.stderr}`);
    }),
  },
  {
    name: 'non-blocking: completes quickly even with detached child spawn',
    fn: () => withTmpEnv((env) => {
      const r = runTrigger(env);
      assert.strictEqual(r.exitCode, 0);
      // The trigger spawns daily-regen.js detached + unref'd, so the parent
      // (this script) should return immediately. Allow generous slack for
      // Windows process-create overhead but cap to flag genuine blocking.
      assert.ok(r.durationMs < 4000,
        `trigger must be non-blocking; took ${r.durationMs}ms`);
    }),
  },
  {
    name: 'survives malformed journals.json (probe failure swallowed)',
    fn: () => withTmpEnv((env) => {
      fs.writeFileSync(path.join(env.claudeDir, 'journals.json'), '{not valid json');
      const r = runTrigger(env);
      assert.strictEqual(r.exitCode, 0, `must swallow probe errors; stderr: ${r.stderr}`);
    }),
  },
  {
    name: 'survives valid journals.json with no log files (cold-start)',
    fn: () => withTmpEnv((env) => {
      // Minimal valid journals.json — empty channels array
      fs.writeFileSync(path.join(env.claudeDir, 'journals.json'),
        JSON.stringify({ channels: [] }));
      const r = runTrigger(env);
      assert.strictEqual(r.exitCode, 0);
    }),
  },
  {
    name: 'no stdout/stderr noise on success (SessionStart should be silent)',
    fn: () => withTmpEnv((env) => {
      const r = runTrigger(env);
      assert.strictEqual(r.exitCode, 0);
      // Script should be silent — any output would land in the user's
      // session-start context unexpectedly.
      assert.strictEqual(r.stdout, '', `unexpected stdout: ${r.stdout.slice(0, 200)}`);
      // stderr is OK to have config warnings, but should not have stack traces
      assert.ok(!/at .+\.js:\d+/.test(r.stderr),
        `stderr must not contain stack traces; got: ${r.stderr.slice(0, 200)}`);
    }),
  },
  {
    name: 'ignores stdin payload (does not parse or echo session_id)',
    fn: () => withTmpEnv((env) => {
      const sid = 'unique-session-marker-deadbeef';
      const r = spawnSync('node', [SCRIPT], {
        encoding: 'utf8', timeout: 5000,
        env: { ...process.env, HOME: env.home, USERPROFILE: env.home,
               CLAUDE_DIR: env.claudeDir, CLAUDE_WORKSPACE: env.home },
        input: JSON.stringify({ session_id: sid }),
      });
      assert.strictEqual(r.status, 0);
      assert.ok(!r.stdout.includes(sid),
        'trigger must not echo stdin contents');
    }),
  },
  {
    name: 'tolerates missing stdin (no payload at all)',
    fn: () => withTmpEnv((env) => {
      const r = spawnSync('node', [SCRIPT], {
        encoding: 'utf8', timeout: 5000,
        env: { ...process.env, HOME: env.home, USERPROFILE: env.home,
               CLAUDE_DIR: env.claudeDir, CLAUDE_WORKSPACE: env.home },
        input: '',
      });
      assert.strictEqual(r.status, 0,
        'should exit 0 even with empty stdin');
    }),
  },
];

module.exports = { tests };

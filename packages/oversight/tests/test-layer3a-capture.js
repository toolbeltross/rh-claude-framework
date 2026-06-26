// Unit tests for rh-layer3a-capture.js — Stop hook that persists Layer 3a
// rejection reasons from stdin to supervisory-log.md and oversight-events.jsonl.
//
// Uses spawnSync with controlled env vars:
//   OVERSIGHT_LOG_PATH  → where rejection entries are appended
//   OVERSIGHT_EVENTS_PATH → where oversight events land (no OVERSIGHT_SELF_TEST
//                           so appendOversightEvent actually runs in rejection tests)
//
// For no-op / resilience tests OVERSIGHT_SELF_TEST=1 suppresses HTTP + event writes.

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'rh-layer3a-capture.js');

function withTmpEnv(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-l3a-test-'));
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const logPath = path.join(home, 'supervisory-log.md');
  const eventsPath = path.join(home, 'oversight-events.jsonl');
  try {
    return fn({ home, claudeDir, logPath, eventsPath });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function runHook(stdinObj, envOverrides = {}) {
  const input = typeof stdinObj === 'string' ? stdinObj : JSON.stringify(stdinObj);
  return spawnSync('node', [SCRIPT], {
    input,
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
    env: {
      ...process.env,
      OVERSIGHT_SELF_TEST: '1',  // suppress HTTP + event writes unless overridden
      ...envOverrides,
    },
  });
}

const tests = [
  // ─── No-op paths ───────────────────────────────────────────────────────────

  {
    name: 'no-op: ok=true does not trigger rejection path',
    fn: () => withTmpEnv(({ logPath }) => {
      runHook({ ok: true, reason: 'some reason', session_id: 'test' },
              { OVERSIGHT_LOG_PATH: logPath });
      assert.ok(!fs.existsSync(logPath), 'log should not be created when ok=true');
    }),
  },
  {
    name: 'no-op: ok=false but no reason field is ignored',
    fn: () => withTmpEnv(({ logPath }) => {
      runHook({ ok: false, session_id: 'test' }, { OVERSIGHT_LOG_PATH: logPath });
      assert.ok(!fs.existsSync(logPath), 'log should not be created when reason is absent');
    }),
  },
  {
    name: 'no-op: input with no rejection candidates → stdout is {}',
    fn: () => {
      const r = runHook({ session_id: 'abc', someOtherField: true });
      assert.strictEqual(r.status, 0, `exit code: ${r.status}`);
      const out = JSON.parse(r.stdout || '{}');
      assert.deepStrictEqual(out, {}, `expected {}, got: ${r.stdout}`);
    },
  },
  {
    name: 'empty stdin → exits 0 (wrapHook fail-open)',
    fn: () => {
      const r = runHook('');
      assert.strictEqual(r.status, 0, `should exit 0 on empty stdin; stderr: ${r.stderr}`);
    },
  },
  {
    name: 'garbage stdin → exits 0 (wrapHook fail-open)',
    fn: () => {
      const r = runHook('this is not json {{ broken');
      assert.strictEqual(r.status, 0, `should exit 0 on garbage stdin`);
    },
  },

  // ─── Rejection detection ────────────────────────────────────────────────────

  {
    name: 'rejection at root: {ok: false, reason: "..."} → appends entry to log',
    fn: () => withTmpEnv(({ logPath }) => {
      runHook({ ok: false, reason: 'test rejection reason', session_id: 'abc123' },
              { OVERSIGHT_LOG_PATH: logPath });
      assert.ok(fs.existsSync(logPath), 'log file should be created');
      const content = fs.readFileSync(logPath, 'utf8');
      assert.ok(content.includes('Layer3a-rejection'), 'should contain rejection marker');
      assert.ok(content.includes('test rejection reason'), 'should contain the reason');
    }),
  },
  {
    name: 'rejection at prompt_result → appends to log',
    fn: () => withTmpEnv(({ logPath }) => {
      runHook({ prompt_result: { ok: false, reason: 'from prompt_result' }, session_id: 'x' },
              { OVERSIGHT_LOG_PATH: logPath });
      const content = fs.readFileSync(logPath, 'utf8');
      assert.ok(content.includes('from prompt_result'));
    }),
  },
  {
    name: 'rejection at result → appends to log',
    fn: () => withTmpEnv(({ logPath }) => {
      runHook({ result: { ok: false, reason: 'from result' }, session_id: 'x' },
              { OVERSIGHT_LOG_PATH: logPath });
      const content = fs.readFileSync(logPath, 'utf8');
      assert.ok(content.includes('from result'));
    }),
  },
  {
    name: 'rejection at previous_result → appends to log',
    fn: () => withTmpEnv(({ logPath }) => {
      runHook({ previous_result: { ok: false, reason: 'from previous_result' }, session_id: 'x' },
              { OVERSIGHT_LOG_PATH: logPath });
      const content = fs.readFileSync(logPath, 'utf8');
      assert.ok(content.includes('from previous_result'));
    }),
  },
  {
    name: 'rejection at last_hook_result → appends to log',
    fn: () => withTmpEnv(({ logPath }) => {
      runHook({ last_hook_result: { ok: false, reason: 'from last_hook_result' }, session_id: 'x' },
              { OVERSIGHT_LOG_PATH: logPath });
      const content = fs.readFileSync(logPath, 'utf8');
      assert.ok(content.includes('from last_hook_result'));
    }),
  },

  // ─── Truncation and session_id slicing ─────────────────────────────────────

  {
    name: 'reason truncated to 400 chars in log entry',
    fn: () => withTmpEnv(({ logPath }) => {
      const longReason = 'A'.repeat(600);
      runHook({ ok: false, reason: longReason, session_id: 'x' },
              { OVERSIGHT_LOG_PATH: logPath });
      const content = fs.readFileSync(logPath, 'utf8');
      // The logged reason should end at 400 'A's — the entry should NOT contain 500+ chars of 'A'
      assert.ok(!content.includes('A'.repeat(401)),
        'reason should be truncated to 400 chars');
      assert.ok(content.includes('A'.repeat(400)),
        'first 400 chars of reason should be present');
    }),
  },
  {
    name: 'session_id sliced to 8 chars in log entry',
    fn: () => withTmpEnv(({ logPath }) => {
      runHook({ ok: false, reason: 'test', session_id: 'longid123456789' },
              { OVERSIGHT_LOG_PATH: logPath });
      const content = fs.readFileSync(logPath, 'utf8');
      assert.ok(content.includes('`longid12`'), `expected sliced session_id; content: ${content}`);
      assert.ok(!content.includes('longid123456789'), 'full session_id should not appear');
    }),
  },
];

module.exports = { tests };

// Unit tests for rh-supervisor-preload.js — SessionStart hook that emits the
// 3-rule self-check framing as additionalContext. Same rule set the Layer 3a
// Stop-hook judges against, reframed as forward guidance.

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'rh-supervisor-preload.js');

function runHook(stdinObj) {
  const input = typeof stdinObj === 'string' ? stdinObj : JSON.stringify(stdinObj);
  const r = spawnSync('node', [SCRIPT], {
    input, encoding: 'utf8', timeout: 5000, windowsHide: true,
    env: { ...process.env, OVERSIGHT_SELF_TEST: '1' },
  });
  return { exitCode: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function parseOutput(r) {
  assert.strictEqual(r.exitCode, 0, `hook exited ${r.exitCode}: ${r.stderr.slice(0, 200)}`);
  return JSON.parse(r.stdout || '{}');
}

const tests = [
  {
    name: 'returns hookSpecificOutput shape with SessionStart event + additionalContext',
    fn: () => {
      const r = runHook({ session_id: 'abc123' });
      const out = parseOutput(r);
      assert.ok(out.hookSpecificOutput, 'hookSpecificOutput required');
      assert.strictEqual(out.hookSpecificOutput.hookEventName, 'SessionStart');
      assert.strictEqual(typeof out.hookSpecificOutput.additionalContext, 'string');
      assert.ok(out.hookSpecificOutput.additionalContext.length > 100,
        'additionalContext should be substantial');
    },
  },
  {
    name: 'additionalContext includes the self-check header',
    fn: () => {
      const out = parseOutput(runHook({}));
      const ctx = out.hookSpecificOutput.additionalContext;
      assert.ok(ctx.includes('Self-check before declaring a turn done'),
        'should include the header');
    },
  },
  {
    name: 'additionalContext names all 3 rules',
    fn: () => {
      const out = parseOutput(runHook({}));
      const ctx = out.hookSpecificOutput.additionalContext;
      assert.ok(ctx.includes('VERIFY BEFORE DECLARING DONE'),
        'rule 1 name expected');
      assert.ok(ctx.includes('SUBAGENT CROSS-CHECK'),
        'rule 2 name expected');
      assert.ok(ctx.includes('NO UNVERIFIED EXTRAPOLATION'),
        'rule 3 name expected');
    },
  },
  {
    name: 'additionalContext cites the source rule files',
    fn: () => {
      const out = parseOutput(runHook({}));
      const ctx = out.hookSpecificOutput.additionalContext;
      assert.ok(ctx.includes('rh-work-verification.md'),
        'should cite the work-verification rule file');
      assert.ok(ctx.includes('rh-subagent-oversight.md'),
        'should cite the subagent-oversight rule file');
      assert.ok(ctx.includes('rh-read-integrity.md'),
        'should cite the read-integrity rule file');
    },
  },
  {
    name: 'output is stable across invocations (no per-call jitter)',
    fn: () => {
      const a = parseOutput(runHook({})).hookSpecificOutput.additionalContext;
      const b = parseOutput(runHook({})).hookSpecificOutput.additionalContext;
      assert.strictEqual(a, b, 'preload text must be deterministic');
    },
  },
  {
    name: 'session_id in input does not leak into output',
    fn: () => {
      const sid = 'unique-session-marker-9f7e461';
      const out = parseOutput(runHook({ session_id: sid }));
      const ctx = out.hookSpecificOutput.additionalContext;
      assert.ok(!ctx.includes(sid),
        'preload should be static — must not interpolate session_id');
    },
  },
  {
    name: 'empty stdin: no crash',
    fn: () => {
      const r = runHook('');
      assert.strictEqual(r.exitCode, 0, 'should not crash on empty stdin');
    },
  },
  {
    name: 'garbage JSON: no crash',
    fn: () => {
      const r = runHook('this is not JSON');
      assert.strictEqual(r.exitCode, 0, 'should not crash on garbage');
    },
  },
  {
    name: 'truncated JSON: no crash',
    fn: () => {
      const r = runHook('{"session_id":');
      assert.strictEqual(r.exitCode, 0, 'should not crash on truncated JSON');
    },
  },
];

module.exports = { tests };

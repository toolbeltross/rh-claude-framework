// Unit tests for rh-path-typo-guard.js — feed PreToolUse:Read payloads,
// check the hookSpecificOutput.updatedInput rewrites .claire/.clone/etc.
// segments to .claude when the corrected path exists on disk.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'rh-path-typo-guard.js');

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

function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-typo-guard-test-'));
  try { return fn(dir); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const tests = [
  {
    name: '.claire path is rewritten to .claude when corrected target exists',
    fn: () => withTmpDir((dir) => {
      // Create the corrected target file at <dir>/.claude/foo.txt
      const realPath = path.join(dir, '.claude', 'foo.txt');
      fs.mkdirSync(path.dirname(realPath), { recursive: true });
      fs.writeFileSync(realPath, 'real content');
      // Feed the typo path to the hook
      const typoPath = path.join(dir, '.claire', 'foo.txt');
      const r = runHook({ tool_input: { file_path: typoPath } });
      const out = parseOutput(r);
      assert.ok(out.hookSpecificOutput, 'should produce hookSpecificOutput');
      assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'allow');
      // Normalize separators for cross-platform comparison
      const updated = out.hookSpecificOutput.updatedInput.file_path.replace(/\\/g, '/');
      assert.strictEqual(updated, realPath.replace(/\\/g, '/'),
        `expected rewrite to ${realPath}, got ${out.hookSpecificOutput.updatedInput.file_path}`);
    }),
  },
  {
    name: '.clone path is rewritten to .claude when corrected target exists',
    fn: () => withTmpDir((dir) => {
      const realPath = path.join(dir, '.claude', 'agents', 'rh-quit.md');
      fs.mkdirSync(path.dirname(realPath), { recursive: true });
      fs.writeFileSync(realPath, '');
      const typoPath = path.join(dir, '.clone', 'agents', 'rh-quit.md');
      const r = runHook({ tool_input: { file_path: typoPath } });
      const out = parseOutput(r);
      const updated = out.hookSpecificOutput.updatedInput.file_path.replace(/\\/g, '/');
      assert.strictEqual(updated, realPath.replace(/\\/g, '/'));
    }),
  },
  {
    name: 'NO rewrite when corrected target does NOT exist (passthrough)',
    fn: () => withTmpDir((dir) => {
      // No file created — neither typo nor corrected exists
      const typoPath = path.join(dir, '.claire', 'missing.txt');
      const r = runHook({ tool_input: { file_path: typoPath } });
      const out = parseOutput(r);
      // Should be empty {} — pass through so Read tool produces normal ENOENT
      assert.deepStrictEqual(out, {},
        'should NOT rewrite when corrected target does not exist (silent retarget unsafe)');
    }),
  },
  {
    name: 'legitimate .claude path is left alone (no typo to correct)',
    fn: () => withTmpDir((dir) => {
      const realPath = path.join(dir, '.claude', 'whatever.txt');
      fs.mkdirSync(path.dirname(realPath), { recursive: true });
      fs.writeFileSync(realPath, '');
      const r = runHook({ tool_input: { file_path: realPath } });
      const out = parseOutput(r);
      assert.deepStrictEqual(out, {}, 'no rewrite expected for clean .claude path');
    }),
  },
  {
    name: '.cluade typo is rewritten when corrected target exists',
    fn: () => withTmpDir((dir) => {
      const realPath = path.join(dir, '.claude', 'rules', 'rh-security.md');
      fs.mkdirSync(path.dirname(realPath), { recursive: true });
      fs.writeFileSync(realPath, '');
      const typoPath = path.join(dir, '.cluade', 'rules', 'rh-security.md');
      const r = runHook({ tool_input: { file_path: typoPath } });
      const out = parseOutput(r);
      assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'allow');
    }),
  },
  {
    name: '.clauds typo is rewritten when corrected target exists',
    fn: () => withTmpDir((dir) => {
      const realPath = path.join(dir, '.claude', 'x.txt');
      fs.mkdirSync(path.dirname(realPath), { recursive: true });
      fs.writeFileSync(realPath, '');
      const typoPath = path.join(dir, '.clauds', 'x.txt');
      const r = runHook({ tool_input: { file_path: typoPath } });
      const out = parseOutput(r);
      assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'allow');
    }),
  },
  {
    name: 'path-segment match: .clone NOT rewritten when not a segment',
    fn: () => {
      // ".clonetone" inside a longer name — pattern requires separator-bounded
      // segment (/.clone/), so this should NOT match.
      const r = runHook({ tool_input: { file_path: '/some/path/.clonetone/file.txt' } });
      const out = parseOutput(r);
      assert.deepStrictEqual(out, {}, 'should not match partial segment');
    },
  },
  {
    name: 'empty file_path: noop',
    fn: () => {
      const r = runHook({ tool_input: { file_path: '' } });
      const out = parseOutput(r);
      assert.deepStrictEqual(out, {});
    },
  },
  {
    name: 'missing tool_input: noop',
    fn: () => {
      const r = runHook({ session_id: 'abc' });
      const out = parseOutput(r);
      assert.deepStrictEqual(out, {});
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
];

module.exports = { tests };

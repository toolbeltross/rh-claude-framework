// Behavioral tests for rh-read-audit.js — the PostToolUse:Read /
// PostToolUse:read_pdf logger + F-06 truncation warning.
//
// Spawn-based (the script runs its effect on load via wrapHook and has no
// exports), so we feed crafted hook payloads on stdin with USERPROFILE pointed
// at a tmp home and assert on the session-reads.log + warn-markers it writes.
// OVERSIGHT_SELF_TEST=1 suppresses the timing-telemetry side channel.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'rh-read-audit.js');

function withTmpHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-read-audit-test-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  try { return fn(home); }
  finally { fs.rmSync(home, { recursive: true, force: true }); }
}

function runHook(home, stdinObj) {
  const input = typeof stdinObj === 'string' ? stdinObj : JSON.stringify(stdinObj);
  const r = spawnSync('node', [SCRIPT], {
    input, encoding: 'utf8', timeout: 5000, windowsHide: true,
    env: { ...process.env, USERPROFILE: home, OVERSIGHT_SELF_TEST: '1' },
  });
  assert.strictEqual(r.status, 0, `hook exited ${r.status}: ${(r.stderr || '').slice(0, 200)}`);
  return { stdout: r.stdout || '', stderr: r.stderr || '', out: JSON.parse(r.stdout || '{}') };
}

const logText = (home) => {
  const p = path.join(home, '.claude', 'session-reads.log');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
};
const markerCount = (home) => {
  const d = path.join(home, '.claude', 'read-warn-markers');
  return fs.existsSync(d) ? fs.readdirSync(d).length : 0;
};
const bigFile = (home, lines) => {
  const p = path.join(home, 'big.txt');
  fs.writeFileSync(p, Array.from({ length: lines }, (_, i) => `line ${i}`).join('\n'));
  return p;
};

const tests = [
  {
    name: 'Read on a small/absent file logs a READ entry, no warning',
    fn: () => withTmpHome((home) => {
      const fp = path.join(home, 'small.txt');
      const { out } = runHook(home, { tool_name: 'Read', tool_input: { file_path: fp } });
      const log = logText(home);
      assert.ok(/\| READ \|/.test(log), 'log should contain a READ entry');
      assert.ok(log.includes(fp), 'log should include the file path');
      assert.deepStrictEqual(out, {}, 'small/absent file should produce no warning output');
      assert.strictEqual(markerCount(home), 0, 'no warn marker for a small/absent file');
    }),
  },
  {
    name: 'Read on a >800-line file with no offset/limit warns once (output + marker)',
    fn: () => withTmpHome((home) => {
      const fp = bigFile(home, 900);
      const { out, stderr } = runHook(home, { tool_name: 'Read', tool_input: { file_path: fp } });
      assert.ok(out.hookSpecificOutput, 'should return hookSpecificOutput with the warning');
      assert.ok(/threshold 800/.test(out.hookSpecificOutput.additionalContext || ''),
        'warning text should cite the 800-line threshold');
      assert.ok(/read-audit/.test(stderr), 'warning should also be written to stderr');
      assert.strictEqual(markerCount(home), 1, 'exactly one warn marker should be created');
    }),
  },
  {
    name: 'second Read of the same big file is suppressed (warn-once)',
    fn: () => withTmpHome((home) => {
      const fp = bigFile(home, 900);
      runHook(home, { tool_name: 'Read', tool_input: { file_path: fp } });  // first → warns
      const { out } = runHook(home, { tool_name: 'Read', tool_input: { file_path: fp } });  // second
      assert.deepStrictEqual(out, {}, 'second read should not re-warn');
      assert.strictEqual(markerCount(home), 1, 'still only one marker after the second read');
    }),
  },
  {
    name: 'Read on a big file WITH offset does not warn (partial read is intentional)',
    fn: () => withTmpHome((home) => {
      const fp = bigFile(home, 900);
      const { out } = runHook(home, { tool_name: 'Read', tool_input: { file_path: fp, offset: 100, limit: 50 } });
      assert.deepStrictEqual(out, {}, 'explicit offset/limit should skip the truncation warning');
      assert.strictEqual(markerCount(home), 0, 'no marker when offset/limit are provided');
    }),
  },
  {
    name: 'pdf-reader read logs a PDF entry with source + page info',
    fn: () => withTmpHome((home) => {
      runHook(home, {
        tool_name: 'mcp__pdf-reader__read_pdf',
        tool_input: { sources: [{ url: 'http://x/a.pdf' }, { url: 'http://x/b.pdf' }], pages: '1-3' },
        tool_output: '{"num_pages": 12}',
      });
      const log = logText(home);
      assert.ok(/\| PDF  \|/.test(log), 'log should contain a PDF entry');
      assert.ok(/sources:2/.test(log), 'PDF entry should record the source count');
      assert.ok(/resp_pages:12/.test(log), 'PDF entry should parse responded page count from output');
    }),
  },
  {
    name: 'other tool logs a generic entry with truncated tool_input',
    fn: () => withTmpHome((home) => {
      runHook(home, { tool_name: 'Bash', tool_input: { command: 'ls -la' } });
      const log = logText(home);
      assert.ok(/\| Bash \|/.test(log), 'log should contain a Bash entry');
      assert.ok(log.includes('ls -la'), 'generic entry should include the tool input');
    }),
  },
];

module.exports = { tests };

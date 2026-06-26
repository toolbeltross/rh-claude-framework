// Unit tests for rh-scribe-staging-read.js — the CLI that /rh-quit and
// rh-scribe-multiscope use to consume the per-session staging file written
// by rh-scribe-staging.js.
//
// Spawn pattern: pre-populate a tmp HOME's scribe-staging dir with a JSONL
// fixture, then run the script with HOME=tmpHome and assert stdout / exit
// code / file removal (for --clear).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'rh-scribe-staging-read.js');

function withTmpHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-staging-read-'));
  const stagingDir = path.join(home, '.claude', 'scribe-staging');
  fs.mkdirSync(stagingDir, { recursive: true });
  try { return fn({ home, stagingDir }); }
  finally { fs.rmSync(home, { recursive: true, force: true }); }
}

function runScript(args, env = {}) {
  const r = spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8', timeout: 5000, windowsHide: true,
    env: { ...process.env, ...env },
  });
  return { exitCode: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function writeFixture(stagingDir, sid, records) {
  const fp = path.join(stagingDir, `staging-${sid}.jsonl`);
  const lines = records.map(r => JSON.stringify({
    ts: r.ts || new Date().toISOString(),
    sid: sid.slice(0, 8),
    chars: (r.text || '').length,
    truncated: !!r.truncated,
    text: r.text || '',
  })).join('\n') + '\n';
  fs.writeFileSync(fp, lines, 'utf-8');
  return fp;
}

const tests = [
  {
    name: 'usage error: no sessionId → exit 1, stderr message',
    fn: () => {
      const r = runScript([]);
      assert.strictEqual(r.exitCode, 1, `expected exit 1, got ${r.exitCode}`);
      assert.match(r.stderr, /usage: rh-scribe-staging-read/);
    },
  },
  {
    name: 'missing staging file → empty text + exit 0 (graceful)',
    fn: () => withTmpHome(({ home }) => {
      const r = runScript(['nonexistent-sid'], { HOME: home, USERPROFILE: home });
      assert.strictEqual(r.exitCode, 0, `stderr: ${r.stderr}`);
      // Default mode prints text + "\n"; missing → just the trailing newline
      assert.strictEqual(r.stdout, '\n');
    }),
  },
  {
    name: 'text mode (default): joins multi-turn text with double-newline separator',
    fn: () => withTmpHome(({ home, stagingDir }) => {
      writeFixture(stagingDir, 'sess123', [
        { text: 'first turn output' },
        { text: 'second turn output' },
      ]);
      const r = runScript(['sess123'], { HOME: home, USERPROFILE: home });
      assert.strictEqual(r.exitCode, 0);
      assert.strictEqual(r.stdout, 'first turn output\n\nsecond turn output\n');
    }),
  },
  {
    name: '--json mode: prints parseable JSON array of records',
    fn: () => withTmpHome(({ home, stagingDir }) => {
      writeFixture(stagingDir, 'sess456', [
        { text: 'alpha' },
        { text: 'beta', truncated: true },
      ]);
      const r = runScript(['sess456', '--json'], { HOME: home, USERPROFILE: home });
      assert.strictEqual(r.exitCode, 0, `stderr: ${r.stderr}`);
      const records = JSON.parse(r.stdout);
      assert.strictEqual(records.length, 2);
      assert.strictEqual(records[0].text, 'alpha');
      assert.strictEqual(records[0].chars, 5);
      assert.strictEqual(records[1].truncated, true);
    }),
  },
  {
    name: '--stats mode: includes turns + totalChars + truncated count + stagingPath',
    fn: () => withTmpHome(({ home, stagingDir }) => {
      writeFixture(stagingDir, 'sess789', [
        { text: 'aaa' },           // 3 chars
        { text: 'bbbbb', truncated: true }, // 5 chars, truncated
        { text: 'cc' },            // 2 chars
      ]);
      const r = runScript(['sess789', '--stats'], { HOME: home, USERPROFILE: home });
      assert.strictEqual(r.exitCode, 0);
      const stats = JSON.parse(r.stdout);
      assert.strictEqual(stats.sessionId, 'sess789');
      assert.strictEqual(stats.turns, 3);
      assert.strictEqual(stats.totalChars, 10);  // 3+5+2
      assert.strictEqual(stats.truncated, 1);
      assert.ok(stats.stagingPath.includes('staging-sess789.jsonl'),
        `stagingPath should reference the session file: ${stats.stagingPath}`);
      assert.strictEqual(typeof stats.enabled, 'boolean');
    }),
  },
  {
    name: '--clear flag: deletes the staging file after print',
    fn: () => withTmpHome(({ home, stagingDir }) => {
      const fp = writeFixture(stagingDir, 'sessClear', [{ text: 'data' }]);
      assert.ok(fs.existsSync(fp), 'precondition: file exists before run');
      const r = runScript(['sessClear', '--clear'], { HOME: home, USERPROFILE: home });
      assert.strictEqual(r.exitCode, 0);
      assert.strictEqual(r.stdout, 'data\n');
      assert.ok(!fs.existsSync(fp), 'staging file should be deleted after --clear');
    }),
  },
  {
    name: '--clear without --stats/--json still uses text mode + clears',
    fn: () => withTmpHome(({ home, stagingDir }) => {
      const fp = writeFixture(stagingDir, 'sessC2', [{ text: 'x' }, { text: 'y' }]);
      const r = runScript(['sessC2', '--clear'], { HOME: home, USERPROFILE: home });
      assert.strictEqual(r.exitCode, 0);
      assert.strictEqual(r.stdout, 'x\n\ny\n');
      assert.ok(!fs.existsSync(fp));
    }),
  },
  {
    name: 'sessionId with invalid chars: safeSid sanitizes (no crash, missing-file path)',
    fn: () => withTmpHome(({ home }) => {
      // Special chars get stripped; effectively maps to a different sid that
      // has no fixture → should print empty + exit 0, not crash.
      const r = runScript(['../../../etc/passwd', '--stats'], { HOME: home, USERPROFILE: home });
      assert.strictEqual(r.exitCode, 0, `stderr: ${r.stderr}`);
      const stats = JSON.parse(r.stdout);
      assert.strictEqual(stats.turns, 0);
      // The sanitized name must not include path traversal chars
      assert.ok(!stats.stagingPath.includes('..'),
        `stagingPath must be sanitized: ${stats.stagingPath}`);
    }),
  },
];

module.exports = { tests };

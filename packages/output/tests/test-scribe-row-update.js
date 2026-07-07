// Tests for rh-scribe-row-update.js — atomic status flip + C4 path allowlist.
// Spawns the CLI against fixtures under a temp CLAUDE_WORKSPACE (RH_SCRIBE_DB=0
// so the DB shadow is a clean no-op). Always run. PLAN-2026-06-15-scribe-disposition-ui.

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'rh-scribe-row-update.js');

function mkWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scribe-rowupd-'));
  const cleanup = path.join(dir, 'cleanup.md');
  fs.writeFileSync(cleanup,
    '| aaaaaaaa | 2026-06-01 | sess1 | first item | open |\n' +
    '| bbbbbbbb | 2026-06-02 | sess2 | second item | open |\n' +
    '<!-- scribe-done -->\n', 'utf8');
  return { dir, cleanup };
}

function run(args, ws) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_WORKSPACE: ws, RH_SCRIBE_DB: '0' },
  });
  let json = null;
  try { json = JSON.parse((res.stdout || '').trim().split('\n').pop()); } catch {}
  return { status: res.status, json, stdout: res.stdout, stderr: res.stderr };
}

const tests = [
  {
    name: 'flips exactly the target row status; sibling + sentinel intact',
    fn: () => {
      const { dir, cleanup } = mkWorkspace();
      const r = run(['--source', cleanup, '--id', 'aaaaaaaa', '--status', 'resolved: done'], dir);
      assert.strictEqual(r.json && r.json.ok, true, `expected ok; got ${r.stdout} ${r.stderr}`);
      assert.strictEqual(r.json.oldStatus, 'open');
      const content = fs.readFileSync(cleanup, 'utf8');
      assert.ok(/\| aaaaaaaa \|.*\| resolved: done \|/.test(content), 'target flipped');
      assert.ok(/\| bbbbbbbb \|.*\| open \|/.test(content), 'sibling untouched');
      assert.strictEqual((content.match(/<!-- scribe-done -->/g) || []).length, 1, 'sentinel intact');
    },
  },
  {
    name: 'dry-run reports match without writing',
    fn: () => {
      const { dir, cleanup } = mkWorkspace();
      const before = fs.readFileSync(cleanup, 'utf8');
      const r = run(['--source', cleanup, '--id', 'bbbbbbbb', '--status', 'stale', '--dry-run'], dir);
      assert.strictEqual(r.json.ok, true);
      assert.strictEqual(r.json.matches, 1);
      assert.strictEqual(r.json.currentStatus, 'open');
      assert.strictEqual(fs.readFileSync(cleanup, 'utf8'), before, 'file unchanged on dry-run');
    },
  },
  {
    name: 'row not found → ok:false, file unchanged',
    fn: () => {
      const { dir, cleanup } = mkWorkspace();
      const before = fs.readFileSync(cleanup, 'utf8');
      const r = run(['--source', cleanup, '--id', 'deadbeef', '--status', 'resolved'], dir);
      assert.strictEqual(r.json.ok, false);
      assert.strictEqual(r.json.error, 'row not found');
      assert.strictEqual(fs.readFileSync(cleanup, 'utf8'), before);
    },
  },
  {
    name: 'C4: a source outside the allowlist (To Do/Migration) is rejected, file untouched',
    fn: () => {
      const { dir } = mkWorkspace();
      const bad = path.join(dir, 'To Do', 'Migration', 'cleanup.md');
      fs.mkdirSync(path.dirname(bad), { recursive: true });
      fs.writeFileSync(bad, '| aaaaaaaa | 2026-06-01 | s | t | open |\n<!-- scribe-done -->\n', 'utf8');
      const before = fs.readFileSync(bad, 'utf8');
      const r = run(['--source', bad, '--id', 'aaaaaaaa', '--status', 'resolved'], dir);
      assert.strictEqual(r.json.ok, false);
      assert.ok(/not in allowlist/.test(r.json.error), `expected allowlist rejection; got ${r.json.error}`);
      assert.strictEqual(fs.readFileSync(bad, 'utf8'), before, 'rejected file untouched');
    },
  },
];

module.exports = { tests };

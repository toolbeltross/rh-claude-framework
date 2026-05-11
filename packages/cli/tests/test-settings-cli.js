// Integration tests for lib/settings-cli.js — exercises validate / show /
// diff / merge / backup / restore subcommands programmatically. Each test
// uses a tmp file pair to avoid touching the user's real settings.json.
//
// P2-4 (2026-05-10).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-settings-cli-'));

// Capture stdout/stderr to assert on output without polluting test runner.
function capture(fn) {
  const out = [];
  const err = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => { out.push(chunk.toString()); return true; };
  process.stderr.write = (chunk) => { err.push(chunk.toString()); return true; };
  let code;
  try { code = fn(); }
  finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return { code, stdout: out.join(''), stderr: err.join('') };
}

const { run } = require('../lib/settings-cli');

function writeJson(name, obj) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
}

const validSettings = {
  env: { FOO: 'bar' },
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: 'node /a.js' }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node /b.js' }] }],
  },
};

const invalidSettings = {
  hooks: {
    Stop: [{ hooks: [{ type: 'command' /* missing command field */ }] }],
  },
};

const tests = [
  // ── validate ───────────────────────────────────────────────────────────
  {
    name: 'validate — valid file exits 0',
    fn: () => {
      const p = writeJson('valid-1.json', validSettings);
      const r = capture(() => run(['validate', p]));
      assert.strictEqual(r.code, 0, r.stderr);
      assert.ok(r.stdout.includes('OK — no issues') || r.stdout.includes('WARNINGS'), r.stdout);
    }
  },
  {
    name: 'validate — invalid file exits 1 and reports the issue',
    fn: () => {
      const p = writeJson('invalid-1.json', invalidSettings);
      const r = capture(() => run(['validate', p]));
      assert.strictEqual(r.code, 1);
      assert.ok(r.stdout.includes('command.missing') || r.stdout.includes('ERRORS'),
        `expected error code in output, got: ${r.stdout}`);
    }
  },
  {
    name: 'validate — missing file exits 3',
    fn: () => {
      const r = capture(() => run(['validate', path.join(TMP, 'does-not-exist.json')]));
      assert.strictEqual(r.code, 3);
    }
  },
  {
    name: 'validate — malformed JSON exits 1 with parse-error code',
    fn: () => {
      const p = path.join(TMP, 'malformed.json');
      fs.writeFileSync(p, '{ this is not valid json ::: ');
      const r = capture(() => run(['validate', p]));
      assert.strictEqual(r.code, 1);
      assert.ok(r.stdout.includes('parse-error'), r.stdout);
    }
  },

  // ── show ───────────────────────────────────────────────────────────────
  {
    name: 'show — prints summary and validation',
    fn: () => {
      const p = writeJson('show-1.json', validSettings);
      const r = capture(() => run(['show', '--path', p]));
      assert.strictEqual(r.code, 0);
      assert.ok(r.stdout.includes('Stop'), 'expected hook phase summary');
      assert.ok(r.stdout.includes('PreToolUse'), 'expected PreToolUse summary');
      assert.ok(r.stdout.includes('OK') || r.stdout.includes('WARNINGS'));
    }
  },
  {
    name: 'show --json — emits parseable JSON with validation field',
    fn: () => {
      const p = writeJson('show-json.json', validSettings);
      const r = capture(() => run(['show', '--path', p, '--json']));
      assert.strictEqual(r.code, 0);
      const obj = JSON.parse(r.stdout);
      assert.ok(obj.settings);
      assert.ok(obj.validation);
      assert.strictEqual(obj.validation.ok, true);
    }
  },

  // ── diff ───────────────────────────────────────────────────────────────
  {
    name: 'diff — shows hook count changes between current and incoming',
    fn: () => {
      const current = writeJson('diff-current.json', {
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node /a.js' }] }] }
      });
      const incoming = writeJson('diff-incoming.json', {
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node /b.js' }] }] }
      });
      const r = capture(() => run(['diff', incoming, '--path', current]));
      assert.strictEqual(r.code, 0);
      assert.ok(r.stdout.includes('Stop:'), r.stdout);
      assert.ok(r.stdout.includes('1 → 2'), `expected hook-count growth, got: ${r.stdout}`);
    }
  },
  {
    name: 'diff — invalid merge result exits 1 (and does NOT write)',
    fn: () => {
      // Current has Stop chain; incoming has a malformed Stop chain that would
      // survive merge as-is and fail validation.
      const current = writeJson('diff-current-2.json', {
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'ok' }] }] }
      });
      const incoming = writeJson('diff-incoming-2.json', {
        hooks: { Stop: [{ hooks: [{ type: 'command' /* missing command */ }] }] }
      });
      const r = capture(() => run(['diff', incoming, '--path', current]));
      assert.strictEqual(r.code, 1);
      assert.ok(r.stdout.includes('ERRORS') || r.stdout.includes('command.missing'), r.stdout);
    }
  },

  // ── merge ──────────────────────────────────────────────────────────────
  {
    name: 'merge — default is dry-run; does NOT modify the file',
    fn: () => {
      const current = writeJson('merge-dry.json', validSettings);
      const incoming = writeJson('merge-dry-in.json', {
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node /new.js' }] }] }
      });
      const before = fs.readFileSync(current, 'utf8');
      const r = capture(() => run(['merge', incoming, '--path', current]));
      assert.strictEqual(r.code, 0);
      assert.ok(r.stdout.includes('[dry-run]'), 'expected dry-run banner');
      const after = fs.readFileSync(current, 'utf8');
      assert.strictEqual(before, after, 'file should NOT be modified in dry-run');
    }
  },
  {
    name: 'merge --apply — writes merged file + creates backup',
    fn: () => {
      const current = writeJson('merge-apply.json', validSettings);
      const incoming = writeJson('merge-apply-in.json', {
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node /new.js' }] }] }
      });
      const r = capture(() => run(['merge', incoming, '--path', current, '--apply']));
      assert.strictEqual(r.code, 0, r.stderr);
      assert.ok(r.stdout.includes('Backup at'), 'expected backup-path message');
      const after = JSON.parse(fs.readFileSync(current, 'utf8'));
      const stopCmds = after.hooks.Stop[0].hooks.map(h => h.command);
      assert.ok(stopCmds.includes('node /a.js'), 'original command preserved');
      assert.ok(stopCmds.includes('node /new.js'), 'new command merged in');
      // Backup file exists
      const baks = fs.readdirSync(TMP).filter(f => f.startsWith('merge-apply.json.bak.'));
      assert.ok(baks.length >= 1, 'expected backup file in tmp dir');
    }
  },
  {
    name: 'merge — invalid result refuses to write even with --apply',
    fn: () => {
      const current = writeJson('merge-bad.json', validSettings);
      const incoming = writeJson('merge-bad-in.json', invalidSettings);
      const beforeContent = fs.readFileSync(current, 'utf8');
      const r = capture(() => run(['merge', incoming, '--path', current, '--apply']));
      assert.strictEqual(r.code, 1);
      assert.ok(r.stderr.includes('failed validation'), r.stderr);
      const afterContent = fs.readFileSync(current, 'utf8');
      assert.strictEqual(beforeContent, afterContent, 'file must not change on validation failure');
    }
  },

  // ── backup / restore ───────────────────────────────────────────────────
  {
    name: 'backup — writes timestamped copy',
    fn: () => {
      const p = writeJson('bk-source.json', validSettings);
      const r = capture(() => run(['backup', '--path', p]));
      assert.strictEqual(r.code, 0);
      const m = r.stdout.match(/Backup written:\s*(.+)/);
      assert.ok(m, 'expected "Backup written:" line');
      assert.ok(fs.existsSync(m[1].trim()), 'backup file should exist on disk');
    }
  },
  {
    name: 'backup --out <path> — writes to explicit destination',
    fn: () => {
      const p = writeJson('bk-source-2.json', validSettings);
      const dest = path.join(TMP, 'explicit-backup.json');
      const r = capture(() => run(['backup', '--path', p, '--out', dest]));
      assert.strictEqual(r.code, 0);
      assert.ok(fs.existsSync(dest));
    }
  },
  {
    name: 'restore — validates backup before replacing target',
    fn: () => {
      const target = writeJson('restore-target.json', { env: { OLD: 'value' } });
      const backup = writeJson('restore-backup.json', validSettings);
      const r = capture(() => run(['restore', backup, '--path', target]));
      assert.strictEqual(r.code, 0);
      const result = JSON.parse(fs.readFileSync(target, 'utf8'));
      assert.strictEqual(result.env.FOO, 'bar', 'target should now contain backup contents');
    }
  },
  {
    name: 'restore — refuses to restore from invalid backup',
    fn: () => {
      const target = writeJson('restore-target-bad.json', validSettings);
      const badBackup = writeJson('restore-bad.json', invalidSettings);
      const r = capture(() => run(['restore', badBackup, '--path', target]));
      assert.strictEqual(r.code, 1);
      // Target should be untouched
      const result = JSON.parse(fs.readFileSync(target, 'utf8'));
      assert.deepStrictEqual(result, validSettings, 'target should be untouched after refused restore');
    }
  },

  // ── error paths ────────────────────────────────────────────────────────
  {
    name: 'unknown subcommand exits 2',
    fn: () => {
      const r = capture(() => run(['nonsense']));
      assert.strictEqual(r.code, 2);
    }
  },
  {
    name: 'no args (or --help) prints help and exits 0',
    fn: () => {
      const r = capture(() => run([]));
      assert.strictEqual(r.code, 0);
      assert.ok(r.stdout.includes('Subcommands') || r.stdout.includes('validate'), r.stdout);
    }
  },
];

module.exports = { tests };

// Regression test: init must NOT overwrite a malformed settings.json.
//
// Origin: 2026-06-30. A malformed (unparseable) ~/.claude/settings.json was
// silently REPLACED with a framework-only file, discarding the user's model,
// permissions, and env (reproduced via the real init CLI against an isolated
// HOME). init now aborts the hooks merge, takes a timestamped backup, and leaves
// the original file untouched. This runs the REAL `rh-oversight init` against a
// tmp HOME whose settings.json is malformed and asserts nothing was clobbered.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin', 'rh-oversight.js');

const tests = [
  {
    name: 'init refuses to overwrite a malformed settings.json (preserves user config + backs up)',
    fn: () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-malformed-'));
      const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-malformed-ws-'));
      const claudeDir = path.join(home, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const settingsPath = path.join(claudeDir, 'settings.json');
      // Malformed JSON (trailing comma) carrying a recognizable user key.
      const original = '{ "model": "opus", "permissions": { "allow": ["__user_marker__"] }, }';
      fs.writeFileSync(settingsPath, original, 'utf8');
      try {
        // init exits 0 overall — it aborts only the hooks merge, not the process.
        // (A non-zero exit would also be acceptable; we assert on file state.)
        try {
          execFileSync('node', [BIN, 'init', '--workspace', ws, '--yes'], {
            env: { ...process.env, HOME: home, USERPROFILE: home },
            stdio: 'pipe',
          });
        } catch { /* ignore exit code — file-state assertions below are the contract */ }

        // The malformed file must be UNCHANGED — user content preserved verbatim.
        const after = fs.readFileSync(settingsPath, 'utf8');
        assert.strictEqual(after, original, 'malformed settings.json must not be overwritten');
        assert.ok(after.includes('__user_marker__'), 'user config must survive the aborted merge');

        // A timestamped backup must have been written.
        const backups = fs.readdirSync(claudeDir).filter((f) => /^settings\.json\.bak\./.test(f));
        assert.ok(backups.length >= 1, 'a timestamped settings.json.bak.* backup must be created');
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(ws, { recursive: true, force: true });
      }
    },
  },
];

module.exports = { tests };

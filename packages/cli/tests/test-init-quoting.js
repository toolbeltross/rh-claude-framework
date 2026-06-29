// Regression test for hook-command path quoting.
//
// Origin: 2026-06-29. The settings.json template emitted hook commands as
//   node {{SCRIPTS_DIR}}/rh-foo.js   (UNQUOTED)
// After init on a home/workspace path containing a space (e.g.
// `C:\Users\First Last`, OneDrive paths, `/Users/First Last`), the resolved
// command `node C:/Users/First Last/.claude/scripts/rh-foo.js` word-splits at
// the space, so the hook runner invokes `node C:/Users/First` →
// "Cannot find module 'C:\Users\First'", and EVERY hook silently fails.
//
// Self-test and all prior tests used space-free tmp HOMEs, so this was never
// exercised. This test runs the REAL `rh-oversight init` against a tmp HOME
// whose path DOES contain a space and asserts the generated commands quote the
// script path so they survive shell word-splitting.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin', 'rh-oversight.js');

// Collect every command string across all hook phases/entries.
function allCommands(settings) {
  const out = [];
  for (const phase of Object.values(settings.hooks || {})) {
    for (const entry of phase || []) {
      for (const h of entry.hooks || []) {
        if (h.command) out.push(h.command);
      }
    }
  }
  return out;
}

const tests = [
  {
    name: 'init on a home path WITH A SPACE quotes every hook script path (spaced-path regression)',
    fn: () => {
      // A tmp root whose directory name deliberately contains a space.
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rh quote ')); // note the trailing space
      const home = path.join(root, 'home dir');   // space again, for good measure
      const ws = path.join(root, 'work space');
      fs.mkdirSync(home, { recursive: true });
      fs.mkdirSync(ws, { recursive: true });
      try {
        assert.ok(home.includes(' '), `precondition: tmp HOME must contain a space — got ${home}`);

        execFileSync('node', [BIN, 'init', '--workspace', ws, '--yes'], {
          env: { ...process.env, HOME: home, USERPROFILE: home },
          stdio: 'pipe',
        });

        const settingsPath = path.join(home, '.claude', 'settings.json');
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        const commands = allCommands(settings);
        assert.ok(commands.length > 0, 'expected at least one generated hook command');

        for (const cmd of commands) {
          // Every command invokes a node script. The script path must be
          // double-quoted so a space in it cannot split the argument.
          assert.ok(
            /^node "[^"]+\.js"/.test(cmd),
            `hook command does not quote its script path: ${cmd}`
          );
          // Belt-and-suspenders: the spaced HOME path, where it appears, must
          // sit inside double quotes (never as a bare, splittable token).
          const slashHome = home.replace(/\\/g, '/');
          if (cmd.includes(slashHome)) {
            assert.ok(
              cmd.includes(`"${slashHome}`) || new RegExp(`"[^"]*${slashHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(cmd),
              `spaced HOME path appears unquoted in command: ${cmd}`
            );
          }
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  },
];

module.exports = { tests };

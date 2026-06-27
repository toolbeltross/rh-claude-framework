// Unit tests for lib/init.js parseArgs — covers the --yes/--no-prompt flag added
// alongside the interactive oversight-dir prompt (feat/init-prompt-oversight-dir).
//
// The interactive prompt itself (promptLineSync + the TTY-guarded call in run())
// is NOT exercised here — it requires a real TTY stdin. Its non-interactive SKIP
// path is covered indirectly: every existing spawn-based CLI test runs with piped
// (non-TTY) stdin and must continue to pass without hanging.

const assert = require('assert');
const { parseArgs } = require('../lib/init');

function withArgv(extra, fn) {
  const saved = process.argv;
  process.argv = ['node', 'rh-oversight.js', 'init', ...extra];
  try { return fn(); } finally { process.argv = saved; }
}

const tests = [
  { name: '--yes sets noPrompt', fn: () => {
    assert.strictEqual(withArgv(['--yes'], parseArgs).noPrompt, true);
  }},
  { name: '-y alias sets noPrompt', fn: () => {
    assert.strictEqual(withArgv(['-y'], parseArgs).noPrompt, true);
  }},
  { name: '--no-prompt alias sets noPrompt', fn: () => {
    assert.strictEqual(withArgv(['--no-prompt'], parseArgs).noPrompt, true);
  }},
  { name: 'absent prompt flag leaves noPrompt undefined (prompt path eligible)', fn: () => {
    assert.strictEqual(withArgv(['--workspace', 'C:/tmp/x'], parseArgs).noPrompt, undefined);
  }},
  { name: '--oversight-dir still parsed (explicit flag wins over prompt)', fn: () => {
    assert.strictEqual(withArgv(['--oversight-dir', 'C:/foo'], parseArgs).oversightDir, 'C:/foo');
  }},
];

module.exports = { tests };

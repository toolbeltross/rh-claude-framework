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

  // ─── unrecognised flags are RECORDED, not silently dropped (2026-08-22) ───
  // `init --help` printed nothing and performed a real install of ~/.claude,
  // because parseArgs ignored every token it did not recognise. run() now
  // refuses on opts.unknownFlags; these tests pin the collection half.
  { name: 'unknown long flag is collected, not ignored', fn: () => {
    assert.deepStrictEqual(withArgv(['--help'], parseArgs).unknownFlags, ['--help']);
  }},
  { name: 'a typo of a real flag is collected (--dryrun is NOT --dry-run)', fn: () => {
    const o = withArgv(['--dryrun'], parseArgs);
    assert.deepStrictEqual(o.unknownFlags, ['--dryrun']);
    assert.strictEqual(o.dryRun, false, 'a typo must not enable the real flag');
  }},
  { name: 'multiple unknown flags all collected', fn: () => {
    assert.deepStrictEqual(withArgv(['-h', '--nope'], parseArgs).unknownFlags, ['-h', '--nope']);
  }},
  { name: 'valid flags leave unknownFlags undefined', fn: () => {
    const o = withArgv(['--yes', '--workspace', 'C:/tmp/x', '--dry-run'], parseArgs);
    assert.strictEqual(o.unknownFlags, undefined);
    assert.strictEqual(o.dryRun, true);
  }},
  { name: 'flag VALUES are not mistaken for flags', fn: () => {
    // --workspace consumes its value via ++i; a path is not a stray flag.
    assert.strictEqual(withArgv(['--workspace', 'C:/tmp/x'], parseArgs).unknownFlags, undefined);
  }},
];

module.exports = { tests };

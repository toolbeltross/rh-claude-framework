// Manual outer-seam harness for P2-4. Not part of the unit suite.
// Spawns `rh-oversight settings ...` and `rh-oversight init` as real
// subprocesses to verify the validator gate and CLI surface work end-to-end.

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const BIN = path.join(REPO_ROOT, 'packages', 'oversight', 'bin', 'rh-oversight.js');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-4-home-'));
const TMP_WS = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-4-ws-'));
fs.mkdirSync(path.join(TMP_WS, '.claude', 'rules'), { recursive: true });
fs.mkdirSync(path.join(TMP_HOME, '.claude'), { recursive: true });

const fails = [];
function assert(cond, msg) {
  if (cond) console.log('  ✓ ' + msg);
  else { console.log('  ✗ ' + msg); fails.push(msg); }
}

function runBin(argv, extraEnv = {}) {
  const env = {
    ...process.env,
    HOME: TMP_HOME, USERPROFILE: TMP_HOME,
    CLAUDE_DIR: TMP_HOME, CLAUDE_WORKSPACE: TMP_WS,
    ...extraEnv,
  };
  return cp.spawnSync(process.execPath, [BIN, ...argv], { env, encoding: 'utf8' });
}

const SETTINGS = path.join(TMP_HOME, '.claude', 'settings.json');
const validObj = {
  env: { TEST: '1' },
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: 'node /a.js' }] }],
  },
};
const invalidObj = {
  hooks: {
    Stop: [{ hooks: [{ type: 'command' /* missing command */ }] }],
  },
};

// ── settings validate ────
console.log('\n[settings validate]');
fs.writeFileSync(SETTINGS, JSON.stringify(validObj, null, 2));
let r = runBin(['settings', 'validate']);
assert(r.status === 0, `valid settings → exit 0 (got ${r.status})`);
assert(r.stdout.includes('OK') || r.stdout.includes('WARNINGS'), 'OK/WARNINGS in output');

fs.writeFileSync(SETTINGS, JSON.stringify(invalidObj, null, 2));
r = runBin(['settings', 'validate']);
assert(r.status === 1, `invalid settings → exit 1 (got ${r.status})`);
assert(r.stdout.includes('command.missing') || r.stdout.includes('ERRORS'), 'error code in output');

// ── settings show ────
console.log('\n[settings show]');
fs.writeFileSync(SETTINGS, JSON.stringify(validObj, null, 2));
r = runBin(['settings', 'show']);
assert(r.status === 0, 'show valid → exit 0');
assert(r.stdout.includes('Stop'), 'show prints hook phase summary');

// ── settings backup + restore ────
console.log('\n[settings backup + restore]');
fs.writeFileSync(SETTINGS, JSON.stringify(validObj, null, 2));
r = runBin(['settings', 'backup']);
assert(r.status === 0, 'backup → exit 0');
const bkMatch = r.stdout.match(/Backup written:\s*(.+)/);
assert(bkMatch && fs.existsSync(bkMatch[1].trim()), 'backup file exists');

// Modify the live file, then restore from backup
fs.writeFileSync(SETTINGS, JSON.stringify({ env: { CHANGED: 'yes' } }, null, 2));
r = runBin(['settings', 'restore', bkMatch[1].trim()]);
assert(r.status === 0, 'restore → exit 0');
const restored = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
assert(restored.env.TEST === '1' && !restored.env.CHANGED, 'restore brought back original env');

// ── settings merge ────
console.log('\n[settings merge]');
fs.writeFileSync(SETTINGS, JSON.stringify(validObj, null, 2));
const incoming = path.join(TMP_HOME, 'incoming.json');
fs.writeFileSync(incoming, JSON.stringify({
  hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node /telemetry.js' }] }] }
}));

// Dry-run
r = runBin(['settings', 'merge', incoming]);
assert(r.status === 0, 'dry-run merge → exit 0');
assert(r.stdout.includes('[dry-run]'), 'dry-run banner present');
const beforeMerge = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
assert(beforeMerge.hooks.Stop[0].hooks.length === 1, 'dry-run did NOT modify file');

// Apply
r = runBin(['settings', 'merge', incoming, '--apply']);
assert(r.status === 0, 'apply merge → exit 0');
const afterMerge = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
assert(afterMerge.hooks.Stop[0].hooks.length === 2, 'file now has 2 hook items');
const cmds = afterMerge.hooks.Stop[0].hooks.map(h => h.command);
assert(cmds.includes('node /a.js') && cmds.includes('node /telemetry.js'), 'both commands present (F-10 shape)');

// Apply with invalid incoming → refuses to write
const badIncoming = path.join(TMP_HOME, 'bad-incoming.json');
fs.writeFileSync(badIncoming, JSON.stringify(invalidObj));
const beforeBad = fs.readFileSync(SETTINGS, 'utf8');
r = runBin(['settings', 'merge', badIncoming, '--apply']);
assert(r.status === 1, 'invalid merge → exit 1');
const afterBad = fs.readFileSync(SETTINGS, 'utf8');
assert(beforeBad === afterBad, 'file untouched after refused merge');

// ── init pre-write validation gate ────
console.log('\n[init pre-write validation gate]');
// Set up a settings.json with a malformed entry that would survive merge
// → init must refuse to write.
fs.writeFileSync(SETTINGS, JSON.stringify({
  env: {},
  hooks: { Stop: [{ hooks: [{ type: 'command' }] }] },  // bad — no command
}, null, 2));
const beforeInit = fs.readFileSync(SETTINGS, 'utf8');
r = runBin(['init', '--workspace', TMP_WS]);
const afterInit = fs.readFileSync(SETTINGS, 'utf8');
// init writes the file even when validation fails? It should NOT.
// init also exits 0 in current shape — what we care about is "did it write a bad file?"
// The combined output should mention validation failure.
const combined = r.stdout + r.stderr;
assert(combined.includes('failed validation') || combined.includes('Aborted'),
  `init should print validation-refusal message; got: ${combined.slice(0, 500)}`);
assert(beforeInit === afterInit,
  'init must NOT overwrite settings.json when pre-write validation fails');

// Cleanup
fs.rmSync(TMP_HOME, { recursive: true, force: true });
fs.rmSync(TMP_WS, { recursive: true, force: true });

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'}: ${fails.length} failures`);
process.exit(fails.length === 0 ? 0 : 1);

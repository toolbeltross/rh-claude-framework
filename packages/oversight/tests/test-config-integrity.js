// Unit tests for rh-config-integrity.js — detect-only Claude-config integrity
// check across 6 probes (json-validity, hook-references, onedrive-hydration,
// zero-byte-config, sync-conflicts, config-presence).
//
// Spawn the script with a controlled HOME/CLAUDE_DIR/CLAUDE_WORKSPACE pointing
// at tmp dirs seeded with specific fixtures, then assert on JSON output, exit
// code, and probe levels. Mirrors test-oversight-health.js.
//
// Note: the onedrive-hydration probe shells out to PowerShell on win32 and is
// 'info' (N/A) elsewhere; on clean tmp fixtures it is 'ok' on Windows. Tests do
// not over-assert on it so they pass on every platform.

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'rh-config-integrity.js');

function mkTmp() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-cfgint-test-'));
  const claudeDir = path.join(home, '.claude');
  const scriptsDir = path.join(claudeDir, 'scripts');
  const agentsDir = path.join(claudeDir, 'agents');
  const wsClaude = path.join(home, 'ws', '.claude');
  const rulesDir = path.join(wsClaude, 'rules');
  const oversightDir = path.join(home, 'oversight');
  for (const d of [scriptsDir, agentsDir, rulesDir, oversightDir]) fs.mkdirSync(d, { recursive: true });
  return { home, claudeDir, scriptsDir, agentsDir, wsClaude, rulesDir, oversightDir, workspace: path.join(home, 'ws') };
}

// Seed a fully-healthy config: a referenced hook script that exists, a valid
// settings.json pointing at it, and a populated rules dir. Returns the env.
function seedClean(t) {
  const ref = path.join(t.scriptsDir, 'rh-some-guard.js').replace(/\\/g, '/');
  fs.writeFileSync(ref, '// guard\nmodule.exports = {};\n');
  const settings = {
    hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: `node ${ref}` }] }] },
  };
  fs.writeFileSync(path.join(t.claudeDir, 'settings.json'), JSON.stringify(settings, null, 2));
  fs.writeFileSync(path.join(t.rulesDir, 'rh-example.md'), '# rule\nbody\n');
  return ref;
}

function run(t, args = []) {
  const r = spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8', timeout: 40000, windowsHide: true,
    env: {
      ...process.env,
      HOME: t.home, USERPROFILE: t.home,
      CLAUDE_DIR: t.claudeDir,
      CLAUDE_WORKSPACE: t.workspace,
      OVERSIGHT_DIR: t.oversightDir,
    },
  });
  return { exitCode: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function withTmp(fn) {
  const t = mkTmp();
  try { return fn(t); }
  finally { fs.rmSync(t.home, { recursive: true, force: true }); }
}

const tests = [
  {
    name: '--json: valid JSON with probes array, exitCode, generated timestamp',
    fn: () => withTmp((t) => {
      seedClean(t);
      const r = run(t, ['--json']);
      const obj = JSON.parse(r.stdout);
      assert.ok(Array.isArray(obj.probes), 'probes must be array');
      assert.strictEqual(typeof obj.exitCode, 'number');
      assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(obj.generated), 'generated must be ISO timestamp');
      assert.strictEqual(typeof obj.filesScanned, 'number');
    }),
  },
  {
    name: '--json: includes all 6 expected probe names, each with name/level/detail',
    fn: () => withTmp((t) => {
      seedClean(t);
      const obj = JSON.parse(run(t, ['--json']).stdout);
      const names = new Set(obj.probes.map(p => p.name));
      for (const n of ['json-validity', 'hook-references', 'onedrive-hydration',
        'zero-byte-config', 'sync-conflicts', 'config-presence']) {
        assert.ok(names.has(n), `expected probe "${n}"; got ${[...names].join(', ')}`);
      }
      for (const p of obj.probes) {
        assert.strictEqual(typeof p.detail, 'string');
        assert.ok(['ok', 'warn', 'crit', 'info'].includes(p.level), `bad level: ${p.level}`);
      }
    }),
  },
  {
    name: 'clean fixture → exit 0, json-validity + hook-references + config-presence all ok',
    fn: () => withTmp((t) => {
      seedClean(t);
      const r = run(t, ['--json']);
      const obj = JSON.parse(r.stdout);
      const lvl = (n) => obj.probes.find(p => p.name === n).level;
      assert.strictEqual(lvl('json-validity'), 'ok', `json-validity ${obj.probes.find(p=>p.name==='json-validity').detail}`);
      assert.strictEqual(lvl('hook-references'), 'ok', `hook-references ${obj.probes.find(p=>p.name==='hook-references').detail}`);
      assert.strictEqual(lvl('config-presence'), 'ok');
      assert.strictEqual(r.exitCode, 0, `expected exit 0; got ${r.exitCode} — ${r.stdout}`);
    }),
  },
  {
    name: 'invalid settings.json → json-validity crit, exit 2',
    fn: () => withTmp((t) => {
      seedClean(t);
      fs.writeFileSync(path.join(t.claudeDir, 'settings.json'), '{ this is not json ');
      const r = run(t, ['--json']);
      const obj = JSON.parse(r.stdout);
      assert.strictEqual(obj.probes.find(p => p.name === 'json-validity').level, 'crit');
      assert.strictEqual(r.exitCode, 2);
    }),
  },
  {
    name: 'settings references a missing script → hook-references crit, exit 2',
    fn: () => withTmp((t) => {
      const missing = path.join(t.scriptsDir, 'rh-does-not-exist.js').replace(/\\/g, '/');
      const settings = { hooks: { Stop: [{ hooks: [{ type: 'command', command: `node ${missing}` }] }] } };
      fs.writeFileSync(path.join(t.claudeDir, 'settings.json'), JSON.stringify(settings));
      fs.writeFileSync(path.join(t.rulesDir, 'rh-example.md'), '# rule\n');
      const r = run(t, ['--json']);
      const probe = JSON.parse(r.stdout).probes.find(p => p.name === 'hook-references');
      assert.strictEqual(probe.level, 'crit', `got ${probe.level} — ${probe.detail}`);
      assert.ok(probe.detail.includes('rh-does-not-exist.js'), `detail should name the file: ${probe.detail}`);
      assert.strictEqual(r.exitCode, 2);
    }),
  },
  {
    name: 'zero-byte .md in critical tree → zero-byte-config crit, exit 2',
    fn: () => withTmp((t) => {
      seedClean(t);
      fs.writeFileSync(path.join(t.rulesDir, 'rh-empty.md'), ''); // 0 bytes
      const r = run(t, ['--json']);
      const probe = JSON.parse(r.stdout).probes.find(p => p.name === 'zero-byte-config');
      assert.strictEqual(probe.level, 'crit', `got ${probe.level} — ${probe.detail}`);
      assert.strictEqual(r.exitCode, 2);
    }),
  },
  {
    name: 'OneDrive "conflicted copy" file → sync-conflicts warn, exit 1 (degraded)',
    fn: () => withTmp((t) => {
      seedClean(t);
      fs.writeFileSync(path.join(t.wsClaude, 'notes (conflicted copy 2026-01-01).md'), 'x\n');
      const r = run(t, ['--json']);
      const obj = JSON.parse(r.stdout);
      const probe = obj.probes.find(p => p.name === 'sync-conflicts');
      assert.strictEqual(probe.level, 'warn', `got ${probe.level} — ${probe.detail}`);
      // No crit-level probe in this fixture → degraded, not critical.
      assert.ok(!obj.probes.some(p => p.level === 'crit'), 'no probe should be crit here');
      assert.strictEqual(r.exitCode, 1, `expected exit 1; got ${r.exitCode}`);
    }),
  },
  {
    name: 'missing core dir (no agents dir) → config-presence crit, exit 2',
    fn: () => withTmp((t) => {
      seedClean(t);
      fs.rmSync(t.agentsDir, { recursive: true, force: true });
      const r = run(t, ['--json']);
      const probe = JSON.parse(r.stdout).probes.find(p => p.name === 'config-presence');
      assert.strictEqual(probe.level, 'crit', `got ${probe.level} — ${probe.detail}`);
      assert.strictEqual(r.exitCode, 2);
    }),
  },
  {
    name: 'default (no --json) prints CLEAN/DEGRADED/CRITICAL banner + exit legend',
    fn: () => withTmp((t) => {
      seedClean(t);
      const r = run(t);
      assert.match(r.stdout, /rh-config-integrity — (CLEAN|DEGRADED|CRITICAL)/, `banner missing: ${r.stdout.slice(0,200)}`);
      assert.match(r.stdout, /Exit: \d .*alert-only/, 'should print alert-only exit legend');
      assert.match(r.stdout, /\[(OK|WARN|CRIT|--)\]/, 'should include status glyphs');
    }),
  },
];

module.exports = { tests };

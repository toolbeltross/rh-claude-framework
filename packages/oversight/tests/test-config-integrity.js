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

function run(t, args = [], extraEnv = {}) {
  const r = spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8', timeout: 40000, windowsHide: true,
    env: {
      ...process.env,
      HOME: t.home, USERPROFILE: t.home,
      CLAUDE_DIR: t.claudeDir,
      CLAUDE_WORKSPACE: t.workspace,
      OVERSIGHT_DIR: t.oversightDir,
      // Neutralised so the host machine's real values cannot leak into a fixture
      // and make a test pass (or fail) for reasons the fixture does not control.
      OneDrive: '', RH_FRAMEWORK_ROOT: '',
      ...extraEnv,
    },
  });
  return { exitCode: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// Seed settings.json with a LAUNCHER-ROUTED hook: rh-fw.js is named by absolute
// path and the framework script is passed as a bare NAME argument. Resolving that
// name requires locating the framework checkout, which is the behaviour under test.
// `nesting` is deliberately NOT the maintainer's org layout — that is the point.
function seedLauncherHook(t, { nesting = ['acme', 'inner', 'fw-checkout'], withForwarder = true } = {}) {
  const launcher = path.join(t.scriptsDir, 'rh-fw.js').split(path.sep).join('/');
  fs.writeFileSync(launcher, '// launcher');
  const settings = {
    hooks: { PostToolUse: [{ matcher: '*', hooks: [
      { type: 'command', command: `node "${launcher}" hook-forwarder.js tool` },
    ] }] },
  };
  fs.writeFileSync(path.join(t.claudeDir, 'settings.json'), JSON.stringify(settings, null, 2));
  fs.writeFileSync(path.join(t.rulesDir, 'rh-example.md'), '# rulebody');
  const scripts = path.join(t.workspace, ...nesting, 'packages', 'telemetry', 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  if (withForwarder) fs.writeFileSync(path.join(scripts, 'hook-forwarder.js'), '// fwd');
  return { scripts, frameworkRoot: path.join(t.workspace, ...nesting) };
}

const lvlOf = (r, name) => JSON.parse(r.stdout).probes.find(p => p.name === name).level;

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
  {
    // Regression: a home path containing a space + quoted hook commands (the
    // form `rh-oversight init` / `rh-telemetry setup` now emit) must NOT be
    // reported as missing. Pre-fix, collectScriptRefs' character-class regex
    // captured only the fragment after the space → false hook-references CRIT
    // at every session close for any user under C:\Users\First Last (etc.).
    name: 'spaced home path + quoted command → hook-references ok (spaced-path regression)',
    fn: () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-cfgint-sp-'));
      const home = path.join(base, 'First Last'); // deliberate space in the path
      const claudeDir = path.join(home, '.claude');
      const scriptsDir = path.join(claudeDir, 'scripts');
      const rulesDir = path.join(home, 'ws', '.claude', 'rules');
      const oversightDir = path.join(home, 'oversight');
      for (const d of [scriptsDir, rulesDir, oversightDir]) fs.mkdirSync(d, { recursive: true });
      try {
        assert.ok(home.includes(' '), 'precondition: home path must contain a space');
        const ref = path.join(scriptsDir, 'rh-some-guard.js').replace(/\\/g, '/');
        fs.writeFileSync(ref, '// guard\n');
        const settings = { hooks: { Stop: [{ hooks: [{ type: 'command', command: `node "${ref}"` }] }] } };
        fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify(settings, null, 2));
        fs.writeFileSync(path.join(rulesDir, 'rh-example.md'), '# rule\n');
        const r = spawnSync('node', [SCRIPT, '--json'], {
          encoding: 'utf8', timeout: 40000, windowsHide: true,
          env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_DIR: claudeDir, CLAUDE_WORKSPACE: path.join(home, 'ws'), OVERSIGHT_DIR: oversightDir },
        });
        const probe = JSON.parse(r.stdout).probes.find(p => p.name === 'hook-references');
        assert.strictEqual(probe.level, 'ok', `spaced-path quoted command should resolve; got ${probe.level} — ${probe.detail}`);
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    },
  },
  // ---- frameworkScriptsDir: the candidate chain, previously UNPINNED ----------
  // Before these, nothing exercised frameworkScriptsDir/RH_FRAMEWORK_ROOT, so the
  // chain could be changed freely without any test noticing — which is why issue
  // #165 claimed a fix could only be verified on the machine that runs oversight.
  {
    // THE REGRESSION TEST for #165. The old code required the maintainer's exact
    // <org>/<wrapper>/<repo> nesting, so on any other layout the checkout was never
    // found and the probe stayed silent. Silence is indistinguishable from health,
    // so the discriminating fixture is a checkout that IS found but is MISSING the
    // referenced script: only a resolver that actually located it can report crit.
    name: 'frameworkScriptsDir: resolves a NON-maintainer nesting (crit proves it was found)',
    fn: () => withTmp((t) => {
      seedLauncherHook(t, { nesting: ['acme', 'inner', 'fw-checkout'], withForwarder: false });
      const r = run(t, ['--json']);
      assert.strictEqual(lvlOf(r, 'hook-references'), 'crit',
        'expected crit: the checkout exists under a non-maintainer nesting and hook-forwarder.js is absent');
    }),
  },
  {
    name: 'frameworkScriptsDir: non-maintainer nesting WITH the script present → ok',
    fn: () => withTmp((t) => {
      seedLauncherHook(t, { nesting: ['acme', 'inner', 'fw-checkout'], withForwarder: true });
      assert.strictEqual(lvlOf(run(t, ['--json']), 'hook-references'), 'ok');
    }),
  },
  {
    name: 'frameworkScriptsDir: no framework anywhere → fail-open (not crit)',
    fn: () => withTmp((t) => {
      const launcher = path.join(t.scriptsDir, 'rh-fw.js').split(path.sep).join('/');
      fs.writeFileSync(launcher, '// launcher');
      fs.writeFileSync(path.join(t.claudeDir, 'settings.json'), JSON.stringify({
        hooks: { PostToolUse: [{ matcher: '*', hooks: [
          { type: 'command', command: `node "${launcher}" hook-forwarder.js tool` }] }] },
      }, null, 2));
      fs.writeFileSync(path.join(t.rulesDir, 'rh-example.md'), '# rule');
      assert.strictEqual(lvlOf(run(t, ['--json']), 'hook-references'), 'ok',
        'a missing optional checkout is not a config-integrity fault');
    }),
  },
  {
    // The override must WIN OUTRIGHT. If it silently fell through to a workspace
    // root, the resolvable-but-incomplete checkout below would be found and the
    // probe would go crit — so 'ok' here is the assertion that it did not.
    name: 'frameworkScriptsDir: RH_FRAMEWORK_ROOT pointing nowhere does NOT fall through',
    fn: () => withTmp((t) => {
      seedLauncherHook(t, { withForwarder: false });
      const r = run(t, ['--json'], { RH_FRAMEWORK_ROOT: path.join(t.home, 'no-such-framework') });
      assert.strictEqual(lvlOf(r, 'hook-references'), 'ok',
        'a dead explicit override must resolve to null, never fall back to a workspace root');
    }),
  },
  {
    name: 'frameworkScriptsDir: RH_FRAMEWORK_ROOT wins when it does resolve',
    fn: () => withTmp((t) => {
      const { frameworkRoot } = seedLauncherHook(t, { withForwarder: false });
      const r = run(t, ['--json'], { RH_FRAMEWORK_ROOT: frameworkRoot });
      assert.strictEqual(lvlOf(r, 'hook-references'), 'crit',
        'override points at the incomplete checkout, so the missing script must surface');
    }),
  },
  {
    name: 'frameworkScriptsDir: oversight.json frameworkRoot is honoured',
    fn: () => withTmp((t) => {
      const { frameworkRoot } = seedLauncherHook(t, { nesting: ['x', 'y', 'z'], withForwarder: false });
      fs.writeFileSync(path.join(t.claudeDir, 'oversight.json'),
        JSON.stringify({ frameworkRoot }, null, 2));
      assert.strictEqual(lvlOf(run(t, ['--json']), 'hook-references'), 'crit',
        'config-provided frameworkRoot must resolve the checkout');
    }),
  },
];

module.exports = { tests };

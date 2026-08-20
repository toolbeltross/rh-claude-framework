// Unit tests for shared/framework.js — the ordered candidate chain that
// resolves the framework checkout for rh-fw.js (per hook invocation),
// rh-daily-validate.js and rh-config-integrity.js.
//
// These three used to carry three private copies of this chain under a comment
// asking humans to keep them in step (rh-config-integrity.js:111). The chain is
// now shared, so its contract is worth pinning: RH_FRAMEWORK_ROOT wins outright
// and never falls through, every candidate is validated against the CALLER's
// target rather than a generic marker, and an unresolvable framework yields
// null so callers can fail open.
//
// Every probe runs in a CHILD process with an isolated HOME. framework.js fixes
// CLAUDE_DIR from HOME at module load, and caches per target, so a fresh child
// is the only reliable isolation — same reasoning as test-config.js.

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const MODULE = path.resolve(__dirname, '..', '..', 'shared', 'framework.js');
const TELEMETRY = 'packages/telemetry/scripts';

function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-fw-resolver-'));
  try { return fn(dir); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// Build a minimal checkout: <root>/package.json + <root>/<relTarget>.
function makeCheckout(root, relTarget = TELEMETRY) {
  fs.mkdirSync(path.join(root, relTarget), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"probe-checkout"}');
  return root;
}

function writeConfig(home, cfg) {
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'oversight.json'), JSON.stringify(cfg));
}

// Resolve `relTarget` in a child with HOME=home. `env` overrides are applied
// last. Returns the resolved absolute path, or null.
//
// The module is loaded from a COPY at <home>/.claude/scripts/lib/framework.js —
// the real installed layout. That matters: loading it from the source tree
// would let step 4 (self-location) resolve this very checkout and mask whatever
// the test is actually asserting about the config chain. Installed, that step
// resolves <home>/.claude, which is not a checkout, exactly as on a real
// machine. Source-tree self-location has its own test below.
function installModule(home) {
  const libDir = path.join(home, '.claude', 'scripts', 'lib');
  fs.mkdirSync(libDir, { recursive: true });
  const dest = path.join(libDir, 'framework.js');
  fs.copyFileSync(MODULE, dest);
  return dest;
}

function resolve(home, relTarget = TELEMETRY, env = {}) {
  const mod = installModule(home);
  const code =
    `const f=require(${JSON.stringify(mod)});` +
    `process.stdout.write(String(f.resolveFrameworkPath(${JSON.stringify(relTarget)})))`;
  const childEnv = { ...process.env, HOME: home, USERPROFILE: home };
  delete childEnv.RH_FRAMEWORK_ROOT;
  delete childEnv.OneDrive;
  Object.assign(childEnv, env);
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: childEnv });
  if (r.status !== 0) throw new Error('resolver probe failed: ' + (r.stderr || ''));
  const out = r.stdout.trim();
  return out === 'null' ? null : out;
}

function workspaceRoots(cfg) {
  const code =
    `const f=require(${JSON.stringify(MODULE)});` +
    `process.stdout.write(JSON.stringify(f.workspaceRoots(${JSON.stringify(cfg)})))`;
  const childEnv = { ...process.env };
  delete childEnv.OneDrive;
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: childEnv });
  if (r.status !== 0) throw new Error('workspaceRoots probe failed: ' + (r.stderr || ''));
  return JSON.parse(r.stdout);
}

const tests = [
  {
    name: 'framework resolver: RH_FRAMEWORK_ROOT resolves when the target exists',
    fn: () => withTmpDir((dir) => {
      const home = path.join(dir, 'home');
      const checkout = makeCheckout(path.join(dir, 'checkout'));
      fs.mkdirSync(home, { recursive: true });
      assert.strictEqual(
        resolve(home, TELEMETRY, { RH_FRAMEWORK_ROOT: checkout }),
        path.join(checkout, TELEMETRY.split('/').join(path.sep))
      );
    }),
  },
  {
    name: 'framework resolver: RH_FRAMEWORK_ROOT wins OUTRIGHT — never falls through to a reachable checkout',
    fn: () => withTmpDir((dir) => {
      // A perfectly good checkout is reachable via oversight.json. The override
      // points somewhere empty. The probe must report NOTHING rather than
      // silently reporting on a framework the launcher is not using.
      const home = path.join(dir, 'home');
      const good = makeCheckout(path.join(dir, 'good'));
      writeConfig(home, { workspace: dir, frameworkRoot: good });
      assert.strictEqual(
        resolve(home, TELEMETRY, { RH_FRAMEWORK_ROOT: path.join(dir, 'empty') }),
        null
      );
    }),
  },
  {
    name: 'framework resolver: oversight.json frameworkRoot is the fast path',
    fn: () => withTmpDir((dir) => {
      const home = path.join(dir, 'home');
      const checkout = makeCheckout(path.join(dir, 'checkout'));
      writeConfig(home, { workspace: path.join(dir, 'nowhere'), frameworkRoot: checkout });
      assert.strictEqual(
        resolve(home, TELEMETRY),
        path.join(checkout, TELEMETRY.split('/').join(path.sep))
      );
    }),
  },
  {
    name: 'framework resolver: workspace x frameworkRelPaths chain resolves the nesting',
    fn: () => withTmpDir((dir) => {
      const home = path.join(dir, 'home');
      const ws = path.join(dir, 'ws');
      const nesting = path.join('org', 'group', 'repo');
      makeCheckout(path.join(ws, nesting));
      writeConfig(home, { workspace: ws, frameworkRelPaths: [nesting] });
      assert.strictEqual(
        resolve(home, TELEMETRY),
        path.join(ws, nesting, TELEMETRY.split('/').join(path.sep))
      );
    }),
  },
  {
    name: 'framework resolver: a stale frameworkRoot falls through to the chain (install-time capture never hard-fails)',
    fn: () => withTmpDir((dir) => {
      const home = path.join(dir, 'home');
      const ws = path.join(dir, 'ws');
      makeCheckout(path.join(ws, 'repo'));
      writeConfig(home, {
        workspace: ws,
        frameworkRoot: path.join(dir, 'moved-away'),   // rotted by a relocation
        frameworkRelPaths: ['repo'],
      });
      assert.strictEqual(
        resolve(home, TELEMETRY),
        path.join(ws, 'repo', TELEMETRY.split('/').join(path.sep))
      );
    }),
  },
  {
    name: 'framework resolver: candidate is validated against the CALLER target, not a generic marker',
    fn: () => withTmpDir((dir) => {
      // The checkout has telemetry scripts but NOT the CLI entry point that
      // rh-daily-validate.js asks for. It must be rejected, not returned.
      const home = path.join(dir, 'home');
      const checkout = makeCheckout(path.join(dir, 'checkout'), TELEMETRY);
      writeConfig(home, { workspace: dir, frameworkRoot: checkout });
      assert.strictEqual(resolve(home, 'packages/cli/bin/rh-oversight.js'), null);
      assert.ok(resolve(home, TELEMETRY), 'the target it DOES have still resolves');
    }),
  },
  {
    name: 'framework resolver: unresolvable framework yields null so callers fail open',
    fn: () => withTmpDir((dir) => {
      const home = path.join(dir, 'home');
      fs.mkdirSync(home, { recursive: true });
      assert.strictEqual(resolve(home, TELEMETRY), null);
    }),
  },
  {
    name: 'framework resolver: absent/invalid oversight.json is tolerated, not thrown',
    fn: () => withTmpDir((dir) => {
      const home = path.join(dir, 'home');
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(home, '.claude', 'oversight.json'), '{ not json');
      assert.strictEqual(resolve(home, TELEMETRY), null);
    }),
  },
  {
    name: 'framework resolver: legacy roots derive from the workspace leaf, with no hardcoded folder name',
    fn: () => {
      // The workspace folder name is the user's, so it must come from config
      // rather than a literal. Deriving the leaf is what lets the legacy
      // cloud-sync fallbacks exist without naming anyone's directory.
      const roots = workspaceRoots({ workspace: path.join('C:', 'somewhere', 'MyCode') });
      assert.ok(roots.some((r) => r.endsWith(`${path.sep}MyCode`)),
        'legacy candidates should carry the configured leaf: ' + JSON.stringify(roots));
      assert.ok(!roots.some((r) => /Workspace$/.test(r)),
        'no candidate may hardcode a workspace folder name: ' + JSON.stringify(roots));
    },
  },
  {
    name: 'framework resolver: with no configured workspace, no legacy root is guessed',
    fn: () => {
      assert.deepStrictEqual(workspaceRoots({}), []);
    },
  },
  {
    name: 'framework resolver: a source tree resolves ITSELF when nothing is configured',
    fn: () => withTmpDir((dir) => {
      // Loaded from the source tree this time (not the installed copy), with an
      // empty HOME so nothing in the config chain can answer. Step 4 should
      // fall back to this checkout — the bare-clone / CI case.
      const home = path.join(dir, 'home');
      fs.mkdirSync(home, { recursive: true });
      const code =
        `const f=require(${JSON.stringify(MODULE)});` +
        `process.stdout.write(String(f.resolveFrameworkPath(${JSON.stringify(TELEMETRY)})))`;
      const childEnv = { ...process.env, HOME: home, USERPROFILE: home };
      delete childEnv.RH_FRAMEWORK_ROOT;
      const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: childEnv });
      assert.strictEqual(r.status, 0, r.stderr);
      const expected = path.resolve(__dirname, '..', '..', '..', TELEMETRY.split('/').join(path.sep));
      assert.strictEqual(r.stdout.trim(), expected);
    }),
  },
  {
    name: 'framework resolver: configuration outranks self-location (source run agrees with installed run)',
    fn: () => withTmpDir((dir) => {
      // Loaded from the source tree, but oversight.json names a DIFFERENT
      // checkout. Config must win, or rh-config-integrity.js run from source
      // would report on its own tree rather than the one the launcher uses.
      const home = path.join(dir, 'home');
      const other = makeCheckout(path.join(dir, 'other'));
      writeConfig(home, { workspace: dir, frameworkRoot: other });
      const code =
        `const f=require(${JSON.stringify(MODULE)});` +
        `process.stdout.write(String(f.resolveFrameworkPath(${JSON.stringify(TELEMETRY)})))`;
      const childEnv = { ...process.env, HOME: home, USERPROFILE: home };
      delete childEnv.RH_FRAMEWORK_ROOT;
      const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: childEnv });
      assert.strictEqual(r.status, 0, r.stderr);
      assert.strictEqual(r.stdout.trim(), path.join(other, TELEMETRY.split('/').join(path.sep)));
    }),
  },
];

module.exports = { tests };

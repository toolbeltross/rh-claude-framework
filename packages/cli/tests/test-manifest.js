// Unit tests for cli/lib/manifest.js — install-manifest engine.
//
// Covers the 3 operation kinds (copyDir / copyFiles / copySubdirs) and the
// resolveTo path placeholder resolver.
//
// Also asserts each sibling package ships an install.json that the engine
// can apply against a tmp dest — guards against schema drift between the
// engine and the per-package manifests.

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  applyManifest, applyOperation, resolveTo,
  sha256File, loadInstallState, saveInstallState,
} = require('../lib/manifest');

const PACKAGES_ROOT = path.join(__dirname, '..', '..');

function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-cli-manifest-'));
  try { return fn(dir); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const tests = [
  {
    name: 'resolveTo: bare key',
    fn: () => {
      assert.strictEqual(resolveTo('scriptsDir', { scriptsDir: '/x' }), '/x');
    },
  },
  {
    name: 'resolveTo: key/subpath joins via path.join',
    fn: () => {
      const r = resolveTo('scriptsDir/lib', { scriptsDir: '/x' });
      assert.strictEqual(r, path.join('/x', 'lib'));
    },
  },
  {
    name: 'resolveTo: unknown key throws',
    fn: () => {
      assert.throws(() => resolveTo('nopeDir', { scriptsDir: '/x' }), /unknown path key/);
    },
  },
  {
    name: 'applyOperation copyDir: copies subtree, returns count',
    fn: () => withTmpDir((dir) => {
      const pkgDir = path.join(dir, 'pkg');
      const dest = path.join(dir, 'dest');
      fs.mkdirSync(path.join(pkgDir, 'src', 'sub'), { recursive: true });
      fs.writeFileSync(path.join(pkgDir, 'src', 'a.js'), '1');
      fs.writeFileSync(path.join(pkgDir, 'src', 'sub', 'b.js'), '2');
      const n = applyOperation(
        { kind: 'copyDir', from: 'src', to: 'destDir' },
        pkgDir,
        { destDir: dest },
        { dryRun: false }
      );
      assert.strictEqual(n, 2);
      assert.ok(fs.existsSync(path.join(dest, 'a.js')));
      assert.ok(fs.existsSync(path.join(dest, 'sub', 'b.js')));
    }),
  },
  {
    name: 'applyOperation copyDir + excludeSubdirs: skips named top-level subdirs',
    fn: () => withTmpDir((dir) => {
      const pkgDir = path.join(dir, 'pkg');
      const dest = path.join(dir, 'dest');
      fs.mkdirSync(path.join(pkgDir, 'src', 'lib'), { recursive: true });
      fs.mkdirSync(path.join(pkgDir, 'src', 'subA'), { recursive: true });
      fs.writeFileSync(path.join(pkgDir, 'src', 'a.js'), 'top-level');
      fs.writeFileSync(path.join(pkgDir, 'src', 'lib', 'shim.js'), 'should-not-ship');
      fs.writeFileSync(path.join(pkgDir, 'src', 'subA', 'kept.js'), 'should-ship');
      const n = applyOperation(
        { kind: 'copyDir', from: 'src', to: 'destDir', excludeSubdirs: ['lib'] },
        pkgDir,
        { destDir: dest },
        { dryRun: false }
      );
      assert.strictEqual(n, 2, `expected 2 files (a.js + subA/kept.js); got ${n}`);
      assert.ok(fs.existsSync(path.join(dest, 'a.js')),
        'top-level file should be copied');
      assert.ok(fs.existsSync(path.join(dest, 'subA', 'kept.js')),
        'non-excluded subdir should be copied');
      assert.ok(!fs.existsSync(path.join(dest, 'lib')),
        'excluded subdir should NOT exist in dest');
      assert.ok(!fs.existsSync(path.join(dest, 'lib', 'shim.js')),
        'excluded subdir contents must not leak');
    }),
  },
  {
    name: 'applyOperation copyDir + excludeSubdirs is top-level only (nested same-name copied)',
    fn: () => withTmpDir((dir) => {
      const pkgDir = path.join(dir, 'pkg');
      const dest = path.join(dir, 'dest');
      // src/lib should be skipped; src/subA/lib should be COPIED (deeper)
      fs.mkdirSync(path.join(pkgDir, 'src', 'lib'), { recursive: true });
      fs.mkdirSync(path.join(pkgDir, 'src', 'subA', 'lib'), { recursive: true });
      fs.writeFileSync(path.join(pkgDir, 'src', 'lib', 'top.js'), 'skip');
      fs.writeFileSync(path.join(pkgDir, 'src', 'subA', 'lib', 'nested.js'), 'keep');
      const n = applyOperation(
        { kind: 'copyDir', from: 'src', to: 'destDir', excludeSubdirs: ['lib'] },
        pkgDir,
        { destDir: dest },
        { dryRun: false }
      );
      assert.strictEqual(n, 1, `expected 1 file (subA/lib/nested.js); got ${n}`);
      assert.ok(!fs.existsSync(path.join(dest, 'lib')),
        'top-level lib excluded');
      assert.ok(fs.existsSync(path.join(dest, 'subA', 'lib', 'nested.js')),
        'nested lib at depth 2 should be copied (excludeSubdirs is top-level only)');
    }),
  },
  {
    name: 'applyOperation copyFiles: copies listed files, skips missing',
    fn: () => withTmpDir((dir) => {
      const pkgDir = path.join(dir, 'pkg');
      const dest = path.join(dir, 'dest');
      fs.mkdirSync(pkgDir);
      fs.writeFileSync(path.join(pkgDir, 'a.js'), '1');
      fs.writeFileSync(path.join(pkgDir, 'c.js'), '3');
      const n = applyOperation(
        { kind: 'copyFiles', files: ['a.js', 'b.js', 'c.js'], to: 'destDir' },
        pkgDir,
        { destDir: dest },
        { dryRun: false }
      );
      assert.strictEqual(n, 2);  // a + c, b skipped
      assert.ok(fs.existsSync(path.join(dest, 'a.js')));
      assert.ok(!fs.existsSync(path.join(dest, 'b.js')));
      assert.ok(fs.existsSync(path.join(dest, 'c.js')));
    }),
  },
  {
    name: 'applyOperation copyFiles + from: copies from a subdir, places by basename',
    fn: () => withTmpDir((dir) => {
      const pkgDir = path.join(dir, 'pkg');
      const dest = path.join(dir, 'dest');
      fs.mkdirSync(path.join(pkgDir, 'scripts', 'lib'), { recursive: true });
      fs.writeFileSync(path.join(pkgDir, 'scripts', 'lib', 'scribe-db.js'), 'canon1');
      fs.writeFileSync(path.join(pkgDir, 'scripts', 'lib', 'context-db.js'), 'canon2');
      // a shim that must NOT be selected (not listed)
      fs.writeFileSync(path.join(pkgDir, 'scripts', 'lib', 'config.js'), 'shim');
      const n = applyOperation(
        { kind: 'copyFiles', from: 'scripts/lib', files: ['scribe-db.js', 'context-db.js'], to: 'libDir' },
        pkgDir,
        { libDir: dest },
        { dryRun: false }
      );
      assert.strictEqual(n, 2, 'two canonicals copied');
      assert.strictEqual(fs.readFileSync(path.join(dest, 'scribe-db.js'), 'utf8'), 'canon1', 'placed flat by basename');
      assert.ok(fs.existsSync(path.join(dest, 'context-db.js')));
      assert.ok(!fs.existsSync(path.join(dest, 'config.js')), 'unlisted shim not copied');
      assert.ok(!fs.existsSync(path.join(dest, 'scripts')), 'no nested scripts/lib path created');
    }),
  },
  {
    name: 'output install.json ships scribe-db + context-db canonicals (not lib shims)',
    fn: () => {
      const outManifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'output', 'install.json'), 'utf8'));
      const cf = outManifest.operations.find(o => o.kind === 'copyFiles' && o.to === 'scriptsDir/lib');
      assert.ok(cf, 'output manifest has a copyFiles → scriptsDir/lib op');
      // the output-owned canonicals (not shims) must be shipped
      for (const required of ['context-db.js', 'scribe-db.js', 'cost-rates.js', 'transcript-telemetry.js']) {
        assert.ok(cf.files.includes(required), `manifest ships ${required}`);
      }
      assert.strictEqual(cf.from, 'scripts/lib');
      // and the blanket copyDir still excludes lib (shims stay out)
      const cd = outManifest.operations.find(o => o.kind === 'copyDir');
      assert.ok(cd.excludeSubdirs.includes('lib'), 'lib still excluded from the dir copy');
    },
  },
  {
    name: 'applyOperation copySubdirs: copies directories only, skips top-level files',
    fn: () => withTmpDir((dir) => {
      const pkgDir = path.join(dir, 'pkg');
      const dest = path.join(dir, 'dest');
      fs.mkdirSync(path.join(pkgDir, 'sk1'), { recursive: true });
      fs.mkdirSync(path.join(pkgDir, 'sk2'), { recursive: true });
      fs.writeFileSync(path.join(pkgDir, 'sk1', 'SKILL.md'), 's1');
      fs.writeFileSync(path.join(pkgDir, 'sk2', 'SKILL.md'), 's2');
      fs.writeFileSync(path.join(pkgDir, 'package.json'), '{}');  // top-level file → skip
      const n = applyOperation(
        { kind: 'copySubdirs', from: '.', to: 'destDir' },
        pkgDir,
        { destDir: dest },
        { dryRun: false }
      );
      assert.strictEqual(n, 2);
      assert.ok(fs.existsSync(path.join(dest, 'sk1', 'SKILL.md')));
      assert.ok(fs.existsSync(path.join(dest, 'sk2', 'SKILL.md')));
      assert.ok(!fs.existsSync(path.join(dest, 'package.json')));
    }),
  },
  {
    name: 'applyOperation: unknown kind throws',
    fn: () => {
      assert.throws(
        () => applyOperation({ kind: 'foo', to: 'x' }, '/p', { x: '/d' }, {}),
        /unknown operation kind/
      );
    },
  },
  {
    name: 'every sibling install.json is well-formed and applies cleanly',
    fn: () => withTmpDir((dir) => {
      const installPaths = {
        scriptsDir: path.join(dir, 'scripts'),
        agentsDir:  path.join(dir, 'agents'),
        skillsDir:  path.join(dir, 'skills'),
        rulesDir:   path.join(dir, 'rules'),
      };
      const packages = ['oversight', 'output', 'shared', 'skills'];
      for (const pkg of packages) {
        const pkgDir = path.join(PACKAGES_ROOT, pkg);
        const manifestPath = path.join(pkgDir, 'install.json');
        assert.ok(fs.existsSync(manifestPath), `${pkg}/install.json missing`);
        // Must parse + must apply without throwing
        const n = applyManifest(pkgDir, installPaths, { dryRun: false });
        assert.ok(n > 0, `${pkg}/install.json copied 0 files (suspicious)`);
      }
    }),
  },
  {
    name: 'shared install runs LAST: shim → canonical override is preserved',
    fn: () => withTmpDir((dir) => {
      // Simulate the install order: oversight (with lib shim) then shared.
      const oversightSrc = path.join(dir, 'oversight-pkg');
      const sharedSrc = path.join(dir, 'shared-pkg');
      const dest = path.join(dir, 'install-dest');
      fs.mkdirSync(path.join(oversightSrc, 'scripts', 'lib'), { recursive: true });
      fs.mkdirSync(sharedSrc);
      fs.writeFileSync(path.join(oversightSrc, 'scripts', 'lib', 'config.js'), '// SHIM\n');
      fs.writeFileSync(path.join(sharedSrc, 'config.js'), '// CANONICAL\n');

      // Step 1: oversight scripts (carries the shim)
      applyOperation(
        { kind: 'copyDir', from: 'scripts', to: 'scriptsDir' },
        oversightSrc, { scriptsDir: dest }, { dryRun: false }
      );
      assert.strictEqual(
        fs.readFileSync(path.join(dest, 'lib', 'config.js'), 'utf8'),
        '// SHIM\n', 'shim should be in place after oversight copy'
      );

      // Step 2: shared lib (overwrites the shim)
      applyOperation(
        { kind: 'copyFiles', files: ['config.js'], to: 'scriptsDir/lib' },
        sharedSrc, { scriptsDir: dest }, { dryRun: false }
      );
      assert.strictEqual(
        fs.readFileSync(path.join(dest, 'lib', 'config.js'), 'utf8'),
        '// CANONICAL\n', 'canonical should overwrite shim post-shared step'
      );
    }),
  },

  // ───────── install guard (F-10 generalised) ─────────
  //
  // F-10: an init silently reverted live changes. settings.json got an additive
  // merge; the ~100 copied files did not. These cover the guard that closes it.

  {
    name: 'guard: a destination edited after install is PROTECTED, not overwritten',
    fn: () => withTmpDir((dir) => {
      const src = path.join(dir, 'pkg'); const dest = path.join(dir, 'dest');
      fs.mkdirSync(src); fs.mkdirSync(dest);
      fs.writeFileSync(path.join(src, 'a.js'), '// FRAMEWORK\n');
      fs.writeFileSync(path.join(dest, 'a.js'), '// LIVE INCIDENT FIX\n');
      const opts = { dryRun: false, installState: {}, protectedFiles: [] };
      applyOperation({ kind: 'copyFiles', files: ['a.js'], to: 'scriptsDir' },
        src, { scriptsDir: dest }, opts);
      assert.strictEqual(fs.readFileSync(path.join(dest, 'a.js'), 'utf8'),
        '// LIVE INCIDENT FIX\n', 'live edit must survive');
      assert.strictEqual(opts.protectedFiles.length, 1, 'must be reported as protected');
    }),
  },
  {
    name: 'guard: an untouched destination IS upgraded (legitimate framework update)',
    fn: () => withTmpDir((dir) => {
      const src = path.join(dir, 'pkg'); const dest = path.join(dir, 'dest');
      fs.mkdirSync(src); fs.mkdirSync(dest);
      fs.writeFileSync(path.join(dest, 'a.js'), '// V1\n');
      fs.writeFileSync(path.join(src, 'a.js'), '// V2\n');
      // state records the dest exactly as installed -> untouched since
      const opts = {
        dryRun: false, protectedFiles: [],
        installState: { [path.join(dest, 'a.js')]: sha256File(path.join(dest, 'a.js')) },
      };
      applyOperation({ kind: 'copyFiles', files: ['a.js'], to: 'scriptsDir' },
        src, { scriptsDir: dest }, opts);
      assert.strictEqual(fs.readFileSync(path.join(dest, 'a.js'), 'utf8'),
        '// V2\n', 'untouched dest must accept the upgrade');
      assert.strictEqual(opts.protectedFiles.length, 0);
    }),
  },
  {
    name: 'guard: --force overwrites a protected destination',
    fn: () => withTmpDir((dir) => {
      const src = path.join(dir, 'pkg'); const dest = path.join(dir, 'dest');
      fs.mkdirSync(src); fs.mkdirSync(dest);
      fs.writeFileSync(path.join(src, 'a.js'), '// FRAMEWORK\n');
      fs.writeFileSync(path.join(dest, 'a.js'), '// LIVE\n');
      const opts = { dryRun: false, installState: {}, protectedFiles: [], force: true };
      applyOperation({ kind: 'copyFiles', files: ['a.js'], to: 'scriptsDir' },
        src, { scriptsDir: dest }, opts);
      assert.strictEqual(fs.readFileSync(path.join(dest, 'a.js'), 'utf8'), '// FRAMEWORK\n');
      assert.strictEqual(opts.protectedFiles.length, 0);
    }),
  },
  {
    name: 'guard: shim → canonical override still works WITH the guard active',
    fn: () => withTmpDir((dir) => {
      // REGRESSION: the first cut of the guard broke this. oversight ships a
      // scripts/lib shim and shared overwrites it with the canonical IN THE SAME
      // RUN; a guard that treats the second write as drift blocks the canonical
      // and installs a broken lib. Recording each write as it happens is what
      // makes the intra-run override legal.
      const oversightSrc = path.join(dir, 'oversight'); const sharedSrc = path.join(dir, 'shared');
      const dest = path.join(dir, 'dest');
      fs.mkdirSync(path.join(oversightSrc, 'scripts', 'lib'), { recursive: true });
      fs.mkdirSync(sharedSrc);
      fs.writeFileSync(path.join(oversightSrc, 'scripts', 'lib', 'config.js'), '// SHIM\n');
      fs.writeFileSync(path.join(sharedSrc, 'config.js'), '// CANONICAL\n');
      const opts = { dryRun: false, installState: {}, protectedFiles: [] };  // ONE opts, as init.js does
      applyOperation({ kind: 'copyDir', from: 'scripts', to: 'scriptsDir' },
        oversightSrc, { scriptsDir: dest }, opts);
      applyOperation({ kind: 'copyFiles', files: ['config.js'], to: 'scriptsDir/lib' },
        sharedSrc, { scriptsDir: dest }, opts);
      assert.strictEqual(fs.readFileSync(path.join(dest, 'lib', 'config.js'), 'utf8'),
        '// CANONICAL\n', 'canonical must still win with the guard active');
      assert.strictEqual(opts.protectedFiles.length, 0, 'intra-run override is not drift');
    }),
  },
  {
    name: 'guard: install state round-trips through save/load',
    fn: () => withTmpDir((dir) => {
      const f = path.join(dir, 'nested', 'state.json');
      assert.strictEqual(saveInstallState(f, { '/a': 'deadbeef' }), true, 'creates parent dir');
      assert.deepStrictEqual(loadInstallState(f), { '/a': 'deadbeef' });
      assert.deepStrictEqual(loadInstallState(path.join(dir, 'missing.json')), {}, 'missing → {}');
      fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
      assert.deepStrictEqual(loadInstallState(path.join(dir, 'bad.json')), {}, 'corrupt → {} not throw');
    }),
  },
];

module.exports = { tests };

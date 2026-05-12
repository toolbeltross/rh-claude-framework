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

const { applyManifest, applyOperation, resolveTo } = require('../lib/manifest');

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
];

module.exports = { tests };

// Unit tests for lib/config.js — path resolution, env var priority, auto-detect.

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

// Resolve config.contextDb in a CHILD process with an isolated empty HOME, so
// the developer's real ~/.claude/oversight.json (which legitimately has
// contextDb:true once `rh-oversight db-init` enables the Postgres shadow) can't
// skew the "off by default" check. config.js fixes CONFIG_PATH from HOME at
// module load, so a fresh child with HOME=<empty> is the reliable isolation.
function contextDbInIsolatedHome(rhContextDb) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-cfg-iso-'));
  try {
    const cfg = path.resolve(__dirname, '..', '..', 'shared', 'config.js');
    const env = { ...process.env, HOME: dir, USERPROFILE: dir };
    delete env.CLAUDE_DIR; delete env.OVERSIGHT_DIR;
    if (rhContextDb === undefined) delete env.RH_CONTEXT_DB; else env.RH_CONTEXT_DB = rhContextDb;
    const r = spawnSync(process.execPath, ['-e',
      `const{resolveConfig}=require(${JSON.stringify(cfg)});process.stdout.write(String(resolveConfig().contextDb))`],
      { encoding: 'utf8', env });
    if (r.status !== 0) throw new Error('isolated config probe failed: ' + (r.stderr || ''));
    return r.stdout.trim() === 'true';
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-oversight-test-'));
  try { fn(dir); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const tests = [
  {
    name: 'config module loads without error',
    fn: () => {
      const { resolveConfig, resetCache } = require('../scripts/lib/config');
      resetCache();
      const c = resolveConfig();
      assert.ok(c.home, 'home should be set');
      assert.ok(c.claudeDir, 'claudeDir should be set');
      assert.ok(c.telemetryPort, 'telemetryPort should be a number');
    },
  },
  {
    name: 'config respects CLAUDE_WORKSPACE env var',
    fn: () => {
      const orig = process.env.CLAUDE_WORKSPACE;
      const { resolveConfig, resetCache } = require('../scripts/lib/config');
      try {
        process.env.CLAUDE_WORKSPACE = '/tmp/test-workspace';
        resetCache();
        const c = resolveConfig();
        assert.strictEqual(c.workspace, '/tmp/test-workspace');
      } finally {
        if (orig === undefined) delete process.env.CLAUDE_WORKSPACE;
        else process.env.CLAUDE_WORKSPACE = orig;
        resetCache();
      }
    },
  },
  {
    name: 'config respects RH_TELEMETRY_PORT env var',
    fn: () => {
      const orig = process.env.RH_TELEMETRY_PORT;
      const { resolveConfig, resetCache } = require('../scripts/lib/config');
      try {
        process.env.RH_TELEMETRY_PORT = '9999';
        resetCache();
        const c = resolveConfig();
        assert.strictEqual(c.telemetryPort, 9999);
        assert.strictEqual(c.telemetryUrl, 'http://localhost:9999');
      } finally {
        if (orig === undefined) delete process.env.RH_TELEMETRY_PORT;
        else process.env.RH_TELEMETRY_PORT = orig;
        resetCache();
      }
    },
  },
  {
    name: 'config contextDb flag: off by default, RH_CONTEXT_DB=1 enables, =0 forces off',
    fn: () => {
      const orig = process.env.RH_CONTEXT_DB;
      const { resolveConfig, resetCache } = require('../scripts/lib/config');
      try {
        delete process.env.RH_CONTEXT_DB;
        resetCache();
        assert.strictEqual(contextDbInIsolatedHome(undefined), false, 'off by default (isolated empty HOME)');
        process.env.RH_CONTEXT_DB = '1';
        resetCache();
        assert.strictEqual(resolveConfig().contextDb, true, 'RH_CONTEXT_DB=1 enables');
        process.env.RH_CONTEXT_DB = '0';
        resetCache();
        assert.strictEqual(resolveConfig().contextDb, false, 'RH_CONTEXT_DB=0 forces off');
      } finally {
        if (orig === undefined) delete process.env.RH_CONTEXT_DB;
        else process.env.RH_CONTEXT_DB = orig;
        resetCache();
      }
    },
  },
  {
    name: 'writeConfig writes and reads back data',
    fn: () => {
      const { writeConfig, resetCache, CONFIG_PATH } = require('../scripts/lib/config');
      let origContent = null;
      try {
        if (fs.existsSync(CONFIG_PATH)) origContent = fs.readFileSync(CONFIG_PATH, 'utf8');
      } catch {}
      try {
        const testVal = `test-${Date.now()}`;
        writeConfig({ _testMarker: testVal });
        resetCache();
        assert.ok(fs.existsSync(CONFIG_PATH), 'oversight.json should exist');
        const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        assert.strictEqual(data._testMarker, testVal);
      } finally {
        if (origContent !== null) fs.writeFileSync(CONFIG_PATH, origContent, 'utf8');
        else try { fs.unlinkSync(CONFIG_PATH); } catch {}
        resetCache();
      }
    },
  },
  {
    name: 'autoDetectWorkspace finds .claude/rules parent',
    fn: () => {
      withTmpDir((dir) => {
        const rulesDir = path.join(dir, '.claude', 'rules');
        fs.mkdirSync(rulesDir, { recursive: true });
        const origCwd = process.cwd();
        const origEnv = process.env.CLAUDE_WORKSPACE;
        try {
          delete process.env.CLAUDE_WORKSPACE;
          process.chdir(dir);
          const { autoDetectWorkspace } = require('../scripts/lib/config');
          const detected = autoDetectWorkspace();
          assert.strictEqual(path.resolve(detected), path.resolve(dir));
        } finally {
          process.chdir(origCwd);
          if (origEnv !== undefined) process.env.CLAUDE_WORKSPACE = origEnv;
        }
      });
    },
  },
  {
    name: 'config defaults privateDirs to empty array',
    fn: () => {
      const { resolveConfig, resetCache } = require('../scripts/lib/config');
      resetCache();
      const c = resolveConfig();
      assert.ok(Array.isArray(c.privateDirs), 'privateDirs should be an array');
    },
  },

  // ─── autoDetectOversightDir — walk-up helper ──────────────────────────────
  // Added 2026-05-19. Motivation: the hardcoded `~/.claude/oversight` default
  // ENOENT'd on machines where the real oversight-system/ lived elsewhere
  // (e.g. <workspace>/<wrapper>/oversight-system/). The walk now finds
  // it automatically — direct match OR one-level-down (the common wrapper
  // pattern).
  {
    name: 'autoDetectOversightDir finds oversight-system/OVERSIGHT_SYSTEM.md in an ancestor (direct)',
    fn: () => {
      withTmpDir((root) => {
        const oversightDir = path.join(root, 'oversight-system');
        fs.mkdirSync(oversightDir);
        fs.writeFileSync(path.join(oversightDir, 'OVERSIGHT_SYSTEM.md'), '# stub\n', 'utf8');
        const nested = path.join(root, 'a', 'b', 'c');
        fs.mkdirSync(nested, { recursive: true });
        const origCwd = process.cwd();
        try {
          process.chdir(nested);
          const { autoDetectOversightDir } = require('../scripts/lib/config');
          assert.strictEqual(
            path.resolve(autoDetectOversightDir()),
            path.resolve(oversightDir),
            'should find oversight-system/ in ancestor'
          );
        } finally {
          process.chdir(origCwd);
        }
      });
    },
  },
  {
    name: 'autoDetectOversightDir finds oversight-system/ one level down (wrapper pattern)',
    fn: () => {
      withTmpDir((root) => {
        // root/setup-wrapper/oversight-system/OVERSIGHT_SYSTEM.md — the wrapper
        // pattern used by <workspace>/<wrapper>/oversight-system/ on the original
        // affected machine.
        const wrapper = path.join(root, 'setup-wrapper');
        const oversightDir = path.join(wrapper, 'oversight-system');
        fs.mkdirSync(oversightDir, { recursive: true });
        fs.writeFileSync(path.join(oversightDir, 'OVERSIGHT_SYSTEM.md'), '# stub\n', 'utf8');
        const projectDir = path.join(root, 'some-project');
        fs.mkdirSync(projectDir);
        const origCwd = process.cwd();
        try {
          process.chdir(projectDir);
          const { autoDetectOversightDir } = require('../scripts/lib/config');
          assert.strictEqual(
            path.resolve(autoDetectOversightDir()),
            path.resolve(oversightDir),
            'should find <wrapper>/oversight-system/ from sibling dir'
          );
        } finally {
          process.chdir(origCwd);
        }
      });
    },
  },
  {
    name: 'autoDetectOversightDir returns null when no oversight-system/ on path',
    fn: () => {
      withTmpDir((root) => {
        // Empty tmp tree with no oversight-system anywhere up to the OS root.
        // The walk is bounded at 10 levels; in a deep $TMPDIR the walk may
        // reach a real oversight-system above, so we mock CWD inside an
        // isolated tree and rely on the bounded walk to give up.
        const inner = path.join(root, 'a', 'b', 'c');
        fs.mkdirSync(inner, { recursive: true });
        const origCwd = process.cwd();
        try {
          process.chdir(inner);
          const { autoDetectOversightDir } = require('../scripts/lib/config');
          const result = autoDetectOversightDir();
          // Either null (no oversight-system on the path) or a path that does
          // NOT contain our tmp root — both prove the helper isn't false-
          // positiving on our empty tree.
          if (result !== null) {
            assert.ok(
              !path.resolve(result).startsWith(path.resolve(root)),
              `did not expect a hit inside the empty tmp tree; got ${result}`
            );
          }
        } finally {
          process.chdir(origCwd);
        }
      });
    },
  },
  {
    name: 'oversightLogPath derives from resolved oversightDir when file/env do not override',
    fn: () => {
      // Sets OVERSIGHT_DIR env var to a known location and confirms that
      // oversightLogPath defaults to <that>/supervisory-log.md — proving the
      // log path now follows oversightDir instead of being decoupled.
      // The user's real oversight.json may set file.oversightLogPath which
      // would take priority over the derived default, so we stub the config
      // file to {} for the duration of the test (then restore).
      const origDir = process.env.OVERSIGHT_DIR;
      const origLog = process.env.OVERSIGHT_LOG_PATH;
      const { resolveConfig, resetCache, CONFIG_PATH } = require('../scripts/lib/config');
      let origContent = null;
      if (fs.existsSync(CONFIG_PATH)) origContent = fs.readFileSync(CONFIG_PATH, 'utf8');
      try {
        // Empty config file so no file.oversightLogPath / file.oversightDir wins.
        fs.writeFileSync(CONFIG_PATH, '{}\n', 'utf8');
        process.env.OVERSIGHT_DIR = '/tmp/custom-oversight';
        delete process.env.OVERSIGHT_LOG_PATH;
        resetCache();
        const c = resolveConfig();
        assert.strictEqual(c.oversightDir, '/tmp/custom-oversight');
        assert.strictEqual(
          c.oversightLogPath.replace(/\\/g, '/'),
          '/tmp/custom-oversight/supervisory-log.md',
          'log path should derive from oversightDir'
        );
      } finally {
        if (origContent !== null) fs.writeFileSync(CONFIG_PATH, origContent, 'utf8');
        else try { fs.unlinkSync(CONFIG_PATH); } catch {}
        if (origDir === undefined) delete process.env.OVERSIGHT_DIR;
        else process.env.OVERSIGHT_DIR = origDir;
        if (origLog === undefined) delete process.env.OVERSIGHT_LOG_PATH;
        else process.env.OVERSIGHT_LOG_PATH = origLog;
        resetCache();
      }
    },
  },
];

module.exports = { tests };

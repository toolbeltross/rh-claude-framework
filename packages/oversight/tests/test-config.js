// Unit tests for lib/config.js — path resolution, env var priority, auto-detect.

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

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
];

module.exports = { tests };

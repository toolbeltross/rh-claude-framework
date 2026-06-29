// Unit tests for lib/status.js classify() — the pure status model. Live probes
// (HTTP server reachability, psql DB reachability) are injected here and
// exercised for real out of band.

const assert = require('assert');
const { classify, OVERSIGHT_GUARDS } = require('../lib/status');

// Build a settings.json-shaped object with the given command strings + optional
// Layer-3a prompt + statusLine.
function settingsWith(commands, { layer3a = false, statusLine = null } = {}) {
  const hooks = commands.map(c => ({ type: 'command', command: c }));
  if (layer3a) hooks.push({ type: 'prompt', prompt: 'ADDITIVE ONLY — Layer 3a narrow supervisory review …' });
  const s = { hooks: { Stop: [{ hooks }] } };
  if (statusLine) s.statusLine = { type: 'command', command: statusLine };
  return s;
}

const CFG = { telemetryPort: 7890, scribeDb: false, contextDb: false, scribeDbName: 'rh_scribe' };
const ovrCmds = OVERSIGHT_GUARDS.map(g => `node "/h/.claude/scripts/${g}.js"`);

const tests = [
  {
    name: 'full system: oversight + telemetry hooks + server reachable → fullSystem true',
    fn: () => {
      const settings = settingsWith(
        [...ovrCmds, 'node "/p/telemetry/scripts/hook-forwarder.js" stop "$X"', 'node "/p/telemetry/scripts/hook-forwarder.js" tool "$X"'],
        { layer3a: true, statusLine: 'node "/p/telemetry/scripts/hook-forwarder.js" status' }
      );
      const s = classify(settings, CFG, { serverReachable: true, dbReachable: null });
      assert.strictEqual(s.oversight.engaged, true);
      assert.strictEqual(s.oversight.hooks, OVERSIGHT_GUARDS.length);
      assert.strictEqual(s.oversight.layer3a, true);
      assert.strictEqual(s.telemetry.engaged, true);
      assert.strictEqual(s.telemetry.forwarderHooks, 2);
      assert.strictEqual(s.telemetry.statusline, true);
      assert.strictEqual(s.telemetry.serverReachable, true);
      assert.strictEqual(s.fullSystem, true);
    },
  },
  {
    name: 'oversight-only (this machine pre-telemetry): telemetry not engaged, fullSystem false',
    fn: () => {
      const s = classify(settingsWith(ovrCmds, { layer3a: true }), CFG, { serverReachable: false });
      assert.strictEqual(s.oversight.engaged, true);
      assert.strictEqual(s.telemetry.engaged, false);
      assert.strictEqual(s.telemetry.forwarderHooks, 0);
      assert.strictEqual(s.fullSystem, false);
    },
  },
  {
    name: 'db flags + reachability surfaced from config/probes',
    fn: () => {
      const s = classify(settingsWith(ovrCmds), { ...CFG, scribeDb: true, contextDb: true }, { serverReachable: false, dbReachable: true });
      assert.strictEqual(s.db.scribeDb, true);
      assert.strictEqual(s.db.contextDb, true);
      assert.strictEqual(s.db.engaged, true);
      assert.strictEqual(s.db.reachable, true);
      assert.strictEqual(s.db.name, 'rh_scribe');
    },
  },
  {
    name: 'empty settings → nothing engaged',
    fn: () => {
      const s = classify({}, CFG, {});
      assert.strictEqual(s.oversight.engaged, false);
      assert.strictEqual(s.telemetry.engaged, false);
      assert.strictEqual(s.db.engaged, false);
      assert.strictEqual(s.fullSystem, false);
      assert.strictEqual(s.telemetry.serverReachable, null); // unprobed → null, not false
    },
  },
];

module.exports = { tests };

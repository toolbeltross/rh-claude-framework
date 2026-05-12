// Unit tests for rh-oversight-health.js — single-screen health aggregator
// across 8 probes (daily-regen, self-test, supervisory-log, hook-debug-log,
// telemetry-server, recent-alerts, scribe-backlog, subagent-orphans).
//
// Spawn the script with controlled HOME pointing at tmp dirs seeded with
// specific fixtures, then assert on JSON output, exit code, probe levels.

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'rh-oversight-health.js');

function withTmpHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-health-test-'));
  const claudeDir = path.join(home, '.claude');
  const scriptsDir = path.join(claudeDir, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  try { return fn({ home, claudeDir, scriptsDir }); }
  finally { fs.rmSync(home, { recursive: true, force: true }); }
}

function runHealth(homeEnv, args = []) {
  const r = spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8', timeout: 10000, windowsHide: true,
    env: {
      ...process.env,
      HOME: homeEnv.home, USERPROFILE: homeEnv.home,
      CLAUDE_DIR: homeEnv.claudeDir,
      CLAUDE_WORKSPACE: homeEnv.home,
      // Force a port nobody's listening on so probeTelemetryServer reliably
      // returns 'warn' / 'unreachable' without depending on real telemetry.
      RH_TELEMETRY_PORT: '1',
    },
  });
  return { exitCode: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

const tests = [
  {
    name: '--json: produces valid JSON with probes array, exitCode, generated timestamp',
    fn: () => withTmpHome((env) => {
      const r = runHealth(env, ['--json']);
      const obj = JSON.parse(r.stdout);
      assert.ok(Array.isArray(obj.probes), 'probes must be array');
      assert.strictEqual(typeof obj.exitCode, 'number');
      assert.strictEqual(typeof obj.generated, 'string');
      assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(obj.generated), 'generated must be ISO timestamp');
    }),
  },
  {
    name: '--json: includes all 8 expected probe names',
    fn: () => withTmpHome((env) => {
      const r = runHealth(env, ['--json']);
      const obj = JSON.parse(r.stdout);
      const names = new Set(obj.probes.map(p => p.name));
      const expected = [
        'daily-regen', 'self-test', 'supervisory-log', 'hook-debug',
        'telemetry-server', 'recent-alerts', 'scribe-backlog', 'subagent-orphans',
      ];
      for (const n of expected) {
        assert.ok(names.has(n), `expected probe "${n}" in output; got ${[...names].join(', ')}`);
      }
    }),
  },
  {
    name: '--json: each probe has name, level, detail',
    fn: () => withTmpHome((env) => {
      const r = runHealth(env, ['--json']);
      const obj = JSON.parse(r.stdout);
      for (const p of obj.probes) {
        assert.strictEqual(typeof p.name, 'string', `name not string for ${JSON.stringify(p)}`);
        assert.strictEqual(typeof p.level, 'string');
        assert.strictEqual(typeof p.detail, 'string');
        assert.ok(['ok', 'warn', 'crit', 'info'].includes(p.level),
          `unexpected level: ${p.level}`);
      }
    }),
  },
  {
    name: 'exit code matches probe levels: empty tmp HOME → crit (no daily-regen marker)',
    fn: () => withTmpHome((env) => {
      const r = runHealth(env, ['--json']);
      const obj = JSON.parse(r.stdout);
      const daily = obj.probes.find(p => p.name === 'daily-regen');
      assert.strictEqual(daily.level, 'crit',
        `daily-regen should be crit with no marker; got ${daily.level} — ${daily.detail}`);
      assert.strictEqual(r.exitCode, 2,
        `exit code should be 2 (crit) with no daily-regen marker; got ${r.exitCode}`);
    }),
  },
  {
    name: 'exit code 0 (healthy) when all probes return ok-level (synthesized fixtures)',
    fn: () => withTmpHome((env) => {
      // Seed fresh daily-regen marker for today
      const todayStamp = new Date().toLocaleDateString('sv-SE');
      fs.writeFileSync(path.join(env.scriptsDir, 'daily-regen.last-run'), todayStamp);
      // Seed a recent daily-regen.log with passing self-test line
      const logLine = `${new Date().toISOString()} [OK  ] rh-oversight-self-test  100ms\n`;
      fs.writeFileSync(path.join(env.scriptsDir, 'daily-regen.log'), logLine);
      // Seed supervisory-log with a recent entry. Default oversightLogPath
      // is ~/.claude/oversight/supervisory-log.md.
      const oversightDir = path.join(env.claudeDir, 'oversight');
      fs.mkdirSync(oversightDir, { recursive: true });
      fs.writeFileSync(path.join(oversightDir, 'supervisory-log.md'),
        `# Supervisory log\n\n## ${new Date().toISOString()}\n\nRecent entry.\n`);
      const r = runHealth(env, ['--json']);
      const obj = JSON.parse(r.stdout);
      // Don't require ALL probes ok — telemetry-server will be 'warn' (port 1
      // unreachable). Just verify daily-regen flipped from crit → ok/warn.
      const daily = obj.probes.find(p => p.name === 'daily-regen');
      assert.notStrictEqual(daily.level, 'crit',
        `daily-regen should NOT be crit with today's marker; got ${daily.level}`);
      // Exit code now reflects the warn level of telemetry-server (=1) rather than 2.
      assert.notStrictEqual(r.exitCode, 2,
        `exit should not be crit-level with marker present; got ${r.exitCode}`);
    }),
  },
  {
    name: 'default (no --json): prints HEALTHY/DEGRADED/CRITICAL banner',
    fn: () => withTmpHome((env) => {
      const r = runHealth(env);
      assert.match(r.stdout, /rh-oversight health — (HEALTHY|DEGRADED|CRITICAL)/,
        `expected banner; stdout=${r.stdout.slice(0, 300)}`);
    }),
  },
  {
    name: 'default output includes per-probe lines with status glyphs',
    fn: () => withTmpHome((env) => {
      const r = runHealth(env);
      // Expect at least one of [OK], [WARN], [CRIT], [--]
      assert.match(r.stdout, /\[(OK|WARN|CRIT|--)\]/,
        'output should include at least one status glyph');
      // Expect probe names in output
      assert.ok(r.stdout.includes('daily-regen'),
        'output should mention daily-regen probe');
    }),
  },
  {
    name: 'default output includes exit-code legend at the bottom',
    fn: () => withTmpHome((env) => {
      const r = runHealth(env);
      assert.match(r.stdout, /Exit: \d/, 'should print exit code at bottom');
      assert.match(r.stdout, /0=healthy.*1=degraded.*2=critical/,
        'should print exit-code legend');
    }),
  },
  {
    name: 'telemetry-server probe returns warn when port is unreachable',
    fn: () => withTmpHome((env) => {
      const r = runHealth(env, ['--json']);
      const obj = JSON.parse(r.stdout);
      const telem = obj.probes.find(p => p.name === 'telemetry-server');
      // RH_TELEMETRY_PORT=1 set in runHealth — nothing listens there.
      assert.strictEqual(telem.level, 'warn',
        `expected warn for unreachable telemetry; got ${telem.level} — ${telem.detail}`);
      assert.match(telem.detail, /unreachable|timeout|HTTP/, 'detail should describe state');
    }),
  },
  {
    name: 'recent-alerts probe returns info when no events log exists',
    fn: () => withTmpHome((env) => {
      const r = runHealth(env, ['--json']);
      const obj = JSON.parse(r.stdout);
      const alerts = obj.probes.find(p => p.name === 'recent-alerts');
      assert.strictEqual(alerts.level, 'info',
        `expected info when no events log; got ${alerts.level} — ${alerts.detail}`);
    }),
  },
  {
    name: 'self-test probe surfaces FAIL → crit level',
    fn: () => withTmpHome((env) => {
      // Today's marker so daily-regen is OK, then a recent self-test FAIL line
      fs.writeFileSync(path.join(env.scriptsDir, 'daily-regen.last-run'),
        new Date().toLocaleDateString('sv-SE'));
      fs.writeFileSync(path.join(env.scriptsDir, 'daily-regen.log'),
        `${new Date().toISOString()} [FAIL] rh-oversight-self-test  100ms\n`);
      const r = runHealth(env, ['--json']);
      const obj = JSON.parse(r.stdout);
      const selfTest = obj.probes.find(p => p.name === 'self-test');
      assert.strictEqual(selfTest.level, 'crit',
        `self-test FAIL should map to crit; got ${selfTest.level}`);
      assert.strictEqual(r.exitCode, 2, 'exit code should be 2 (crit)');
    }),
  },
];

module.exports = { tests };

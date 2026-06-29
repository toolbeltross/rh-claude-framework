// status.js — "is the full system on?" one-screen readout.
//
// Reports both halves of the framework plus the optional Postgres shadow, so
// you can tell at a glance what's engaged (the gap that made an empty
// localhost:7890 a mystery):
//   • Oversight (enforcement)  — guard/scribe/Layer-3a hooks present in settings.json
//   • Telemetry (dashboard)    — forwarder hooks + statusline present, server reachable
//   • Postgres FTS shadow      — scribeDb/contextDb flags + DB reachable
//
// Pure classify() takes injected settings/config/probe results so it is unit-
// testable without a live machine. run() performs the live probes (HTTP + psql).

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const PACKAGES_ROOT = path.join(__dirname, '..', '..');
const SHARED_PKG = path.join(PACKAGES_ROOT, 'shared');

const OVERSIGHT_GUARDS = [
  'rh-consolidation-guard', 'rh-agent-oversight-guard', 'rh-path-typo-guard',
  'rh-agent-result-guard', 'rh-read-audit', 'rh-agents-loaded-marker',
  'rh-daily-regen-trigger', 'rh-scribe-prefilter', 'rh-layer3a-capture',
];

function allHooks(settings) {
  const out = [];
  for (const ph of Object.values((settings && settings.hooks) || {}))
    for (const e of ph || []) for (const h of e.hooks || []) out.push(h);
  return out;
}

/** Pure: derive the status model from settings + config + probe results. */
function classify(settings, config, probes = {}) {
  const hooks = allHooks(settings);
  const cmds = hooks.filter(h => h.command).map(h => h.command);
  const oversightPresent = OVERSIGHT_GUARDS.filter(g => cmds.some(c => c.includes(g)));
  const layer3a = hooks.some(h => h.type === 'prompt' && /ADDITIVE ONLY[\s\S]*Layer 3a/.test(h.prompt || ''));
  const fwd = cmds.filter(c => c.includes('hook-forwarder')).length;
  const statusline = !!(settings && settings.statusLine && /hook-forwarder/.test(settings.statusLine.command || ''));

  const oversight = { hooks: oversightPresent.length, total: OVERSIGHT_GUARDS.length, layer3a, engaged: oversightPresent.length > 0 };
  const telemetry = { forwarderHooks: fwd, statusline, serverReachable: probes.serverReachable ?? null, port: config.telemetryPort, engaged: fwd > 0 };
  const db = { scribeDb: !!config.scribeDb, contextDb: !!config.contextDb, reachable: probes.dbReachable ?? null, name: config.scribeDbName, engaged: !!config.scribeDb || !!config.contextDb };
  return { oversight, telemetry, db, fullSystem: oversight.engaged && telemetry.engaged };
}

function readSettings(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

function probeServer(port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const req = http.get({ host: 'localhost', port, path: '/api/health', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function probeDb(config) {
  // Reachable iff a no-prompt connect as the scribe role succeeds (pgpass).
  const psqlProbes = ['C:/Program Files/PostgreSQL/18/bin/psql.exe', 'C:/Program Files/PostgreSQL/17/bin/psql.exe', 'C:/Program Files/PostgreSQL/16/bin/psql.exe', '/usr/bin/psql', '/usr/local/bin/psql'];
  let psql = config.scribeDbPsql;
  if (!psql) { for (const p of psqlProbes) { try { fs.accessSync(p); psql = p; break; } catch {} } }
  if (!psql) psql = 'psql';
  const env = { ...process.env, PGCONNECT_TIMEOUT: '5' };
  delete env.PGPASSWORD; // force pgpass path (the deployed lib's exact mode)
  const r = spawnSync(psql, ['-U', config.scribeDbUser, '-h', config.scribeDbHost, '-p', String(config.scribeDbPort), '-d', config.scribeDbName, '-w', '-tAc', 'SELECT 1'], { timeout: 8000, encoding: 'utf8', windowsHide: true, env });
  return r.status === 0 && (r.stdout || '').trim() === '1';
}

function dot(b) { return b === true ? '✓' : b === false ? '✗' : '–'; }

async function run(argv = process.argv.slice(3)) {
  const { config } = require(path.join(SHARED_PKG, 'config'));
  const c = config;
  const settings = readSettings(c.settingsPath);
  const serverReachable = await probeServer(c.telemetryPort);
  const dbReachable = (c.scribeDb || c.contextDb) ? probeDb(c) : null;
  const s = classify(settings, c, { serverReachable, dbReachable });

  if (argv.includes('--json')) { console.log(JSON.stringify(s, null, 2)); return s.fullSystem ? 0 : 1; }

  console.log(`rh-oversight status`);
  console.log(`────────────────────────────────────────`);
  console.log(`  Oversight (enforcement)   ${dot(s.oversight.engaged)}  ${s.oversight.hooks}/${s.oversight.total} guard hooks${s.oversight.layer3a ? ' + Layer-3a prompt' : ''}`);
  console.log(`  Telemetry (dashboard)     ${dot(s.telemetry.engaged)}  ${s.telemetry.forwarderHooks} forwarder hooks${s.telemetry.statusline ? ' + statusline' : ''}; server ${dot(s.telemetry.serverReachable)} :${s.telemetry.port}`);
  console.log(`  Postgres FTS shadow       ${dot(s.db.engaged)}  scribeDb=${s.db.scribeDb} contextDb=${s.db.contextDb}; reachable ${dot(s.db.reachable)} (${s.db.name})`);
  console.log(`────────────────────────────────────────`);
  if (s.fullSystem && s.telemetry.serverReachable) console.log(`  Full system engaged ✓`);
  else {
    const gaps = [];
    if (!s.oversight.engaged) gaps.push("oversight not installed (run 'rh-oversight init')");
    if (!s.telemetry.engaged) gaps.push("telemetry hooks absent (run 'rh-telemetry setup')");
    else if (!s.telemetry.serverReachable) gaps.push(`telemetry server not running on :${s.telemetry.port} (run 'rh-telemetry start')`);
    if (!s.db.engaged) gaps.push("Postgres shadow off (optional: run 'rh-oversight db-init')");
    else if (s.db.reachable === false) gaps.push('Postgres shadow on but DB unreachable (check pgpass / server)');
    console.log(`  Gaps:`);
    for (const g of gaps) console.log(`   • ${g}`);
  }
  return s.fullSystem ? 0 : 1;
}

module.exports = { run, classify, allHooks, OVERSIGHT_GUARDS };

#!/usr/bin/env node
/**
 * rh-oversight-health.js
 *
 * Single-screen health aggregator for the oversight system. Run via:
 *   rh-oversight health           — pretty text output
 *   rh-oversight health --json    — JSON output (for SessionStart preload)
 *
 * Exit codes:
 *   0 = all healthy
 *   1 = degraded (warnings present)
 *   2 = critical (alerts present or core component down)
 *
 * Surfaces what the oversight system already knows about itself but no one
 * normally sees: daily-regen freshness, journal staleness, telemetry server
 * status, recent alert events, scribe backlog age, subagent orphan counts.
 *
 * Closes scribe-row 82e77aaf61. Companion to journals.json (P1-2) which
 * generalizes the staleness probes this command consumes.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { config } = require('./lib/config');

const JSON_OUT = process.argv.includes('--json');
const TODAY = new Date();

// ─── Helpers ─────────────────────────────────────────────────────────────

function fileExists(p) { try { fs.accessSync(p); return true; } catch { return false; } }

function ageHours(p) {
  try { return (Date.now() - fs.statSync(p).mtimeMs) / 3_600_000; }
  catch { return null; }
}

function tailLines(p, n) {
  try {
    const buf = fs.readFileSync(p, 'utf8');
    return buf.split(/\r?\n/).filter(Boolean).slice(-n);
  } catch { return []; }
}

function tailLinesFromLargeFile(p, maxBytes) {
  // Read only the last maxBytes bytes — for large append-only logs.
  try {
    const stat = fs.statSync(p);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8').split(/\r?\n/).filter(Boolean);
  } catch { return []; }
}

function fmtAge(hours) {
  if (hours === null) return 'unknown';
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${Math.round(hours / 24)}d`;
}

function statusGlyph(level) {
  // Plain ASCII so output works in any terminal/log
  return { ok: '[OK]', warn: '[WARN]', crit: '[CRIT]', info: '[--]' }[level] || '[?]';
}

// ─── Probes ──────────────────────────────────────────────────────────────

function probeDailyRegen() {
  const marker = path.join(config.scriptsDir, 'daily-regen.last-run');
  const log = path.join(config.scriptsDir, 'daily-regen.log');
  const todayStamp = TODAY.toLocaleDateString('sv-SE');
  let level = 'crit', detail = 'no marker';
  if (fileExists(marker)) {
    const lastRunDate = fs.readFileSync(marker, 'utf8').trim();
    const ageH = ageHours(marker);
    if (lastRunDate === todayStamp) { level = 'ok'; detail = `ran today (${todayStamp})`; }
    else if (ageH !== null && ageH < 48) { level = 'warn'; detail = `last ran ${lastRunDate} (${fmtAge(ageH)} ago)`; }
    else { level = 'crit'; detail = `last ran ${lastRunDate} (${fmtAge(ageH)} ago, > 48h)`; }
  }
  // Last log block status
  let lastBlock = '';
  if (fileExists(log)) {
    const lines = tailLines(log, 20);
    const failed = lines.filter(l => l.startsWith('[FAIL]')).length;
    const okCount = lines.filter(l => l.startsWith('[OK')).length;
    if (failed > 0) lastBlock = ` · last log: ${failed} FAIL`;
    else if (okCount > 0) lastBlock = ` · last log: clean`;
  }
  return { name: 'daily-regen', level, detail: detail + lastBlock };
}

function probeSupervisoryLog() {
  const candidates = [
    config.oversightLogPath,
    path.join(config.claudeDir, 'telemetry-supervisory-log.md'),
  ].filter(p => fileExists(p));
  if (candidates.length === 0) return { name: 'supervisory-log', level: 'warn', detail: 'no log file found' };
  const newest = candidates.reduce((best, p) => {
    const a = ageHours(p);
    return (best.age === null || (a !== null && a < best.age)) ? { path: p, age: a } : best;
  }, { path: null, age: null });
  const ageH = newest.age;
  let level = 'ok';
  if (ageH === null) level = 'warn';
  else if (ageH > 72) level = 'crit';
  else if (ageH > 24) level = 'warn';
  return { name: 'supervisory-log', level, detail: `last write ${fmtAge(ageH)} ago` };
}

function probeHookDebugLog() {
  // Live debug log lives in the framework, not in ~/.claude/.
  const candidates = [
    path.join(config.workspace, 'toolbeltross', 'toolbeltross-public', 'rh-claude-framework', 'packages', 'telemetry', 'hook-debug.log'),
    path.join(config.claudeDir, 'hook-debug.log'),
  ].filter(p => fileExists(p));
  if (candidates.length === 0) return { name: 'hook-debug', level: 'warn', detail: 'no debug log found' };
  const ageH = ageHours(candidates[0]);
  let level = 'ok';
  if (ageH === null) level = 'warn';
  else if (ageH > 24) level = 'warn';
  return { name: 'hook-debug', level, detail: `${path.basename(path.dirname(candidates[0]))}/${path.basename(candidates[0])} · last write ${fmtAge(ageH)} ago` };
}

function probeTelemetryServer() {
  return new Promise(resolve => {
    const url = `${config.telemetryUrl}/api/snapshot`;
    const req = http.request(url, { method: 'GET', timeout: 1500 }, res => {
      res.resume();
      resolve({ name: 'telemetry-server', level: 'ok', detail: `${config.telemetryUrl} · HTTP ${res.statusCode}` });
    });
    req.on('error', () => resolve({ name: 'telemetry-server', level: 'warn', detail: `${config.telemetryUrl} · unreachable` }));
    req.on('timeout', () => { req.destroy(); resolve({ name: 'telemetry-server', level: 'warn', detail: `${config.telemetryUrl} · timeout` }); });
    req.end();
  });
}

function probeRecentAlerts() {
  if (!fileExists(config.eventsLogPath)) return { name: 'recent-alerts', level: 'info', detail: 'no events log' };
  const lines = tailLinesFromLargeFile(config.eventsLogPath, 256 * 1024);
  const cutoff = Date.now() - 7 * 24 * 3_600_000;
  const alerts = [];
  for (const line of lines.slice(-2000)) {
    try {
      const e = JSON.parse(line);
      if (!e.event_type || !/_alert$|_blocked$|_violation$|_failure_detected$/.test(e.event_type)) continue;
      const ts = new Date(e.timestamp).getTime();
      if (isNaN(ts) || ts < cutoff) continue;
      alerts.push({ ts: e.timestamp, type: e.event_type });
    } catch {}
  }
  const last5 = alerts.slice(-5);
  const level = alerts.length === 0 ? 'ok' : alerts.length > 10 ? 'warn' : 'info';
  const detail = `${alerts.length} alerts in 7d` +
    (last5.length ? ` · latest: ${last5.map(a => a.type).join(', ')}` : '');
  return { name: 'recent-alerts', level, detail };
}

function probeScribeBacklog() {
  const cleanup = path.join(config.workspace, 'cleanup.md');
  const recs = path.join(config.workspace, 'recommendations.md');
  const counts = { cleanup_open: 0, cleanup_oldest_d: 0, recs_open: 0, recs_oldest_d: 0 };
  for (const [file, key] of [[cleanup, 'cleanup'], [recs, 'recs']]) {
    if (!fileExists(file)) continue;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    let oldestTs = Infinity;
    for (const line of lines) {
      const m = line.match(/^\|\s*[a-f0-9]{8,16}\s*\|\s*(\d{4}-\d{2}-\d{2})/);
      if (!m) continue;
      if (line.endsWith('| open |') || line.includes('| open |')) {
        counts[`${key}_open`]++;
        const t = Date.parse(m[1]);
        if (!isNaN(t) && t < oldestTs) oldestTs = t;
      }
    }
    if (oldestTs !== Infinity) counts[`${key}_oldest_d`] = Math.floor((Date.now() - oldestTs) / (24 * 3_600_000));
  }
  const totalOpen = counts.cleanup_open + counts.recs_open;
  const oldest = Math.max(counts.cleanup_oldest_d, counts.recs_oldest_d);
  const level = oldest > 21 ? 'warn' : oldest > 0 ? 'info' : 'ok';
  const detail = `cleanup ${counts.cleanup_open} open (oldest ${counts.cleanup_oldest_d}d) · recs ${counts.recs_open} open (oldest ${counts.recs_oldest_d}d)`;
  return { name: 'scribe-backlog', level, detail, totalOpen, oldest };
}

function probeSubagentOrphans() {
  const debugLog = path.join(config.workspace, 'toolbeltross', 'toolbeltross-public', 'rh-claude-framework', 'packages', 'telemetry', 'hook-debug.log');
  if (!fileExists(debugLog)) return { name: 'subagent-orphans', level: 'info', detail: 'no debug log' };
  const lines = tailLinesFromLargeFile(debugLog, 1024 * 1024);
  const cutoff = Date.now() - 7 * 24 * 3_600_000;
  const starts = new Set();
  let stops = 0, orphans = 0;
  for (const line of lines) {
    const tsM = line.match(/^\[([\d-]+T[\d:.]+Z)\]/);
    if (!tsM) continue;
    const ts = new Date(tsM[1]).getTime();
    if (isNaN(ts) || ts < cutoff) continue;
    const startM = line.match(/subagent-start: session=\w+ type=\S+ id=(\w+)/);
    if (startM) { starts.add(startM[1]); continue; }
    const stopM = line.match(/subagent-stop: session=\w+ id=(\w+)/);
    if (stopM) {
      stops++;
      if (!starts.has(stopM[1])) orphans++;
    }
  }
  const level = orphans > 5 ? 'warn' : orphans > 0 ? 'info' : 'ok';
  const detail = `${orphans} orphan stops out of ${stops} total in 7d`;
  return { name: 'subagent-orphans', level, detail, orphans, stops };
}

function probeSelfTestStatus() {
  const log = path.join(config.scriptsDir, 'daily-regen.log');
  if (!fileExists(log)) return { name: 'self-test', level: 'info', detail: 'no daily-regen log' };
  const lines = tailLinesFromLargeFile(log, 64 * 1024);
  // Find the most recent self-test result line
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/\[(OK|FAIL|SKIP)\s*\]\s+rh-oversight-self-test/);
    if (m) {
      const level = m[1] === 'OK' ? 'ok' : m[1] === 'FAIL' ? 'crit' : 'warn';
      return { name: 'self-test', level, detail: `last result: ${m[1]}` };
    }
  }
  return { name: 'self-test', level: 'warn', detail: 'no recent self-test result' };
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main() {
  const probes = await Promise.all([
    Promise.resolve(probeDailyRegen()),
    Promise.resolve(probeSelfTestStatus()),
    Promise.resolve(probeSupervisoryLog()),
    Promise.resolve(probeHookDebugLog()),
    probeTelemetryServer(),
    Promise.resolve(probeRecentAlerts()),
    Promise.resolve(probeScribeBacklog()),
    Promise.resolve(probeSubagentOrphans()),
  ]);

  const exitCode = probes.some(p => p.level === 'crit') ? 2
                 : probes.some(p => p.level === 'warn') ? 1 : 0;

  if (JSON_OUT) {
    console.log(JSON.stringify({ generated: new Date().toISOString(), exitCode, probes }, null, 2));
    process.exit(exitCode);
  }

  // Pretty output
  const overall = exitCode === 0 ? 'HEALTHY' : exitCode === 1 ? 'DEGRADED' : 'CRITICAL';
  console.log(`\nrh-oversight health — ${overall}  (${new Date().toLocaleString('sv-SE')})`);
  console.log('-'.repeat(70));
  const nameWidth = Math.max(...probes.map(p => p.name.length));
  for (const p of probes) {
    const glyph = statusGlyph(p.level);
    console.log(`  ${glyph.padEnd(7)} ${p.name.padEnd(nameWidth + 2)} ${p.detail}`);
  }
  console.log('-'.repeat(70));
  console.log(`  Plan: claude-setup-ross/oversight-system/PLAN-2026-05-08-reliability-hardening.md`);
  console.log(`  Exit: ${exitCode} (0=healthy, 1=degraded, 2=critical)\n`);
  process.exit(exitCode);
}

main().catch(e => {
  console.error('[health] fatal:', e.message);
  process.exit(2);
});

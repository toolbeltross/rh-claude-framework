#!/usr/bin/env node
/**
 * hook-perf-cli.js — CLI for hook latency stats.
 *
 * Reads from GET /api/hook-perf when the server is running, falls back to
 * reading ~/.claude/hook-perf.jsonl directly when it's not.
 *
 * Usage:
 *   rh-telemetry hook-perf            Per-hook p50/p95/max (last 24h)
 *   rh-telemetry hook-perf slowest    Top 10 slowest invocations
 *   rh-telemetry hook-perf regressions   Detect p95 regressions vs 7-day baseline
 */

import { readFileSync } from 'fs';
import { PORT, HOOK_PERF_LOG_PATH } from '../server/config.js';

const subcommand = process.argv[2] || 'stats';

async function fetchJSON(path) {
  try {
    const res = await fetch(`http://localhost:${PORT}/api${path}`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) return await res.json();
  } catch {}
  return null;
}

function loadLocal() {
  try {
    const content = readFileSync(HOOK_PERF_LOG_PATH, 'utf-8');
    return content.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(p * sorted.length) - 1;
  return Math.round(sorted[Math.max(0, idx)] * 10) / 10;
}

function computeLocalStats(records, sinceMs = Date.now() - 24 * 60 * 60 * 1000) {
  const sinceISO = new Date(sinceMs).toISOString();
  const recent = records.filter(r => r.ts >= sinceISO);
  const byHook = {};
  for (const r of recent) {
    if (!byHook[r.hook]) byHook[r.hook] = [];
    byHook[r.hook].push(r.durationMs);
  }
  const stats = {};
  for (const [hook, durations] of Object.entries(byHook)) {
    durations.sort((a, b) => a - b);
    const count = durations.length;
    stats[hook] = {
      count,
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      max: durations[count - 1],
      mean: Math.round((durations.reduce((s, d) => s + d, 0) / count) * 10) / 10,
    };
  }
  return stats;
}

function pad(str, len) { return String(str).padEnd(len); }
function rpad(str, len) { return String(str).padStart(len); }

function printStats(stats) {
  const hooks = Object.keys(stats).sort();
  if (hooks.length === 0) {
    console.log('No hook performance data found.');
    return;
  }

  console.log('\n=== Hook Performance (last 24h) ===\n');
  console.log(`${pad('Hook', 28)} ${rpad('Count', 7)} ${rpad('p50', 8)} ${rpad('p95', 8)} ${rpad('max', 8)} ${rpad('mean', 8)}  Status`);
  console.log('─'.repeat(82));

  for (const hook of hooks) {
    const s = stats[hook];
    const status = s.p95 > 100 ? 'WARN' : s.max > 1000 ? 'WARN' : 'ok';
    const statusColor = status === 'WARN' ? ' ⚠' : '';
    console.log(
      `${pad(hook, 28)} ${rpad(s.count, 7)} ${rpad(s.p50 + 'ms', 8)} ${rpad(s.p95 + 'ms', 8)} ${rpad(s.max + 'ms', 8)} ${rpad(s.mean + 'ms', 8)}  ${status}${statusColor}`
    );
  }
  console.log();
}

function printSlowest(records) {
  if (records.length === 0) {
    console.log('No hook performance data found.');
    return;
  }
  console.log('\n=== Slowest Hook Invocations (last 24h) ===\n');
  console.log(`${pad('Hook', 28)} ${rpad('Duration', 10)} ${pad('Time', 20)} ${pad('Session', 10)} ${pad('Outcome', 10)}`);
  console.log('─'.repeat(82));
  for (const r of records) {
    const time = r.ts ? r.ts.replace('T', ' ').replace(/\.\d+Z$/, '') : '';
    console.log(`${pad(r.hook, 28)} ${rpad(r.durationMs + 'ms', 10)} ${pad(time, 20)} ${pad(r.sessionId || '-', 10)} ${pad(r.outcome || '-', 10)}`);
  }
  console.log();
}

function printRegressions(regressions) {
  if (regressions.length === 0) {
    console.log('\nNo hook latency regressions detected (24h vs 7d baseline).\n');
    return;
  }
  console.log('\n=== Hook Latency Regressions ===\n');
  for (const r of regressions) {
    console.log(`  ⚠ ${r.hook}: p95 ${r.currentP95}ms (24h) vs ${r.baselineP95}ms (7d baseline) — ${r.ratio}x increase`);
  }
  console.log();
}

async function main() {
  if (subcommand === 'slowest') {
    const data = await fetchJSON('/hook-perf/slowest');
    if (data) {
      printSlowest(data);
    } else {
      const records = loadLocal();
      const sinceISO = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const recent = records.filter(r => r.ts >= sinceISO).sort((a, b) => b.durationMs - a.durationMs).slice(0, 10);
      printSlowest(recent);
    }
  } else if (subcommand === 'regressions') {
    const data = await fetchJSON('/hook-perf/regressions');
    if (data) {
      printRegressions(data);
    } else {
      console.log('Regression detection requires the telemetry server. Run: rh-telemetry start');
    }
  } else {
    const data = await fetchJSON('/hook-perf');
    if (data) {
      printStats(data);
    } else {
      const records = loadLocal();
      const stats = computeLocalStats(records);
      printStats(stats);
    }
  }
}

main();

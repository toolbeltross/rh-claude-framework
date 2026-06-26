#!/usr/bin/env node
// hook-perf-audit.js — p95 regression detection and JSONL rotation.

const fs = require('fs');
const path = require('path');
const { config } = require('./config');

const PERF_LOG = config.perfLogPath;
const ARCHIVE_LOG = PERF_LOG + '.1';
const MAX_SIZE_BYTES = 5 * 1024 * 1024;

function loadRecords() {
  try {
    const content = fs.readFileSync(PERF_LOG, 'utf8');
    return content.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(p * sorted.length) - 1;
  return Math.round(sorted[Math.max(0, idx)] * 10) / 10;
}

function getStats(records, sinceISO) {
  const recent = records.filter(r => r.ts >= sinceISO);
  const byHook = {};
  for (const r of recent) {
    if (!byHook[r.hook]) byHook[r.hook] = [];
    byHook[r.hook].push(r.durationMs);
  }
  const stats = {};
  for (const [hook, durations] of Object.entries(byHook)) {
    durations.sort((a, b) => a - b);
    stats[hook] = { count: durations.length, p95: percentile(durations, 0.95), max: durations[durations.length - 1] };
  }
  return stats;
}

function main() {
  try {
    const stat = fs.statSync(PERF_LOG);
    if (stat.size > MAX_SIZE_BYTES) {
      try { fs.unlinkSync(ARCHIVE_LOG); } catch {}
      fs.renameSync(PERF_LOG, ARCHIVE_LOG);
      console.log(`[OK  ] hook-perf-audit / rotated ${PERF_LOG} (${Math.round(stat.size / 1024)}KB → .1)`);
    }
  } catch {}

  const records = loadRecords();
  if (records.length === 0) {
    console.log('[WARN] hook-perf-audit / no records in hook-perf.jsonl');
    process.exit(0);
  }

  const now = new Date();
  const since24h = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const since7d = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  const current = getStats(records, since24h);
  const baseline = getStats(records, since7d);

  let warnings = 0;
  for (const [hook, cur] of Object.entries(current)) {
    const base = baseline[hook];
    if (!base || base.count < 5) continue;
    if (cur.p95 > base.p95 * 2 && cur.p95 > 50) {
      console.log(`[WARN] hook-perf-audit / ${hook} — p95 regression: ${cur.p95}ms (24h) vs ${base.p95}ms (7d baseline)`);
      warnings++;
    }
  }

  const recent24h = records.filter(r => r.ts >= since24h);
  const extremes = recent24h.filter(r => r.durationMs > 1000);
  if (extremes.length > 0) {
    for (const e of extremes.slice(0, 3)) {
      console.log(`[WARN] hook-perf-audit / ${e.hook} took ${e.durationMs}ms at ${e.ts}`);
      warnings++;
    }
  }

  if (warnings === 0) {
    const hookCount = Object.keys(current).length;
    console.log(`[OK  ] hook-perf-audit / ${hookCount} hooks, ${recent24h.length} invocations (24h), no regressions`);
  }

  process.exit(0);
}

main();

/**
 * hook-perf-store.js — In-memory ring buffer + JSONL persistence for hook
 * latency records. Follows the FailureStore pattern (append-only JSONL on
 * disk, capped in-memory cache for fast queries).
 *
 * Records are written by oversight hooks via POST /api/hook-perf and also
 * loaded from ~/.claude/hook-perf.jsonl on server start.
 */

import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { HOOK_PERF_LOG_PATH, MAX_HOOK_PERF_CACHE } from './config.js';

export class HookPerfStore {
  constructor(filePath = HOOK_PERF_LOG_PATH) {
    this.filePath = filePath;
    this.cache = [];
    this.maxCache = MAX_HOOK_PERF_CACHE;
    /** @type {((record: object) => void) | null} */
    this.onAppend = null;
  }

  load() {
    if (!existsSync(this.filePath)) {
      console.log(`[hook-perf] No existing file at ${this.filePath} — starting fresh`);
      return;
    }
    try {
      const content = readFileSync(this.filePath, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      for (const line of lines) {
        try { this.cache.push(JSON.parse(line)); } catch {}
      }
      if (this.cache.length > this.maxCache) {
        this.cache = this.cache.slice(-this.maxCache);
      }
      console.log(`[hook-perf] Loaded ${this.cache.length} perf records`);
    } catch (err) {
      console.error(`[hook-perf] Error loading: ${err.message}`);
    }
  }

  append(record) {
    const normalized = {
      ts: record.ts || new Date().toISOString(),
      hook: record.hook || 'unknown',
      durationMs: typeof record.durationMs === 'number' ? record.durationMs : 0,
      sessionId: record.sessionId || '',
      outcome: record.outcome || 'noop',
      hookType: record.hookType || '',
      matcher: record.matcher || '',
    };

    // 2026-05-08: server-side appendFileSync removed to fix double-write to
    // hook-perf.jsonl. The hook itself (lib/hook-timing.js appendPerf) is the
    // sole disk writer; server holds the in-memory cache and serves API. On
    // server restart, load() reads from disk to repopulate cache. POST that
    // doesn't originate from a hook (e.g., manual test) won't persist —
    // acceptable trade-off; was producing duplicate entries with same ts.

    this.cache.push(normalized);
    if (this.cache.length > this.maxCache) {
      this.cache = this.cache.slice(-this.maxCache);
    }

    if (this.onAppend) this.onAppend(normalized);
    return normalized;
  }

  getStats(since = Date.now() - 24 * 60 * 60 * 1000) {
    const sinceISO = new Date(since).toISOString();
    const recent = this.cache.filter(r => r.ts >= sinceISO);

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

  getSlowest(n = 10, since = Date.now() - 24 * 60 * 60 * 1000) {
    const sinceISO = new Date(since).toISOString();
    return this.cache
      .filter(r => r.ts >= sinceISO)
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, n);
  }

  detectRegressions(baselineSince = Date.now() - 7 * 24 * 60 * 60 * 1000, currentSince = Date.now() - 24 * 60 * 60 * 1000) {
    const baseline = this.getStats(baselineSince);
    const current = this.getStats(currentSince);
    const regressions = [];

    for (const [hook, cur] of Object.entries(current)) {
      const base = baseline[hook];
      if (!base || base.count < 5) continue;
      if (cur.p95 > base.p95 * 2 && cur.p95 > 50) {
        regressions.push({ hook, baselineP95: base.p95, currentP95: cur.p95, ratio: Math.round(cur.p95 / base.p95 * 10) / 10 });
      }
    }
    return regressions;
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(p * sorted.length) - 1;
  return Math.round(sorted[Math.max(0, idx)] * 10) / 10;
}

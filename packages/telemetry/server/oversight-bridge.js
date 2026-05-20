/**
 * Façade over the oversight-events feed.
 *
 * Per Phase 0.6 recommendation: wrap cross-package data access in a stable
 * server-side module so multiple v2 routers can consume it without each
 * duplicating path resolution or JSONL parse logic.
 *
 * Reads ~/.claude/oversight-events.jsonl directly. The supervisor-sweep
 * module in @rh/oversight does deeper time-windowed aggregation; this
 * bridge is the lightweight always-available counterpart.
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const HOME = process.env.HOME || process.env.USERPROFILE || homedir();
const EVENTS_PATH = join(HOME, '.claude', 'oversight-events.jsonl');

/**
 * Parse the oversight-events JSONL and return events newer than `sinceMs`.
 * Returns { eventsByType, recent, total, oldest, newest }.
 *
 * @param {object} opts
 * @param {number} [opts.sinceMs] — epoch ms; events older than this are skipped (default: 7 days ago)
 * @param {number} [opts.recentLimit] — number of most-recent events to include verbatim (default: 50)
 */
export async function readOversightEvents({ sinceMs = Date.now() - 7 * 24 * 60 * 60 * 1000, recentLimit = 50 } = {}) {
  if (!existsSync(EVENTS_PATH)) {
    return { eventsByType: {}, recent: [], total: 0, oldest: null, newest: null, sourcePath: EVENTS_PATH };
  }

  let buf;
  try {
    buf = await readFile(EVENTS_PATH, 'utf8');
  } catch (err) {
    return { eventsByType: {}, recent: [], total: 0, oldest: null, newest: null, sourcePath: EVENTS_PATH, error: err.message };
  }

  const eventsByType = {};
  const all = [];
  let oldest = null;
  let newest = null;

  for (const line of buf.split('\n')) {
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : null;
    if (oldest === null || (ts && ts < oldest)) oldest = ts;
    if (newest === null || (ts && ts > newest)) newest = ts;
    if (ts && ts < sinceMs) continue;
    const type = obj.event_type || 'unknown';
    if (!eventsByType[type]) {
      eventsByType[type] = { count: 0, lastSeen: null, sampleSessionIds: new Set() };
    }
    eventsByType[type].count++;
    if (!eventsByType[type].lastSeen || (ts && ts > eventsByType[type].lastSeen)) {
      eventsByType[type].lastSeen = ts;
    }
    const sid = obj.data?.session_id;
    if (sid) eventsByType[type].sampleSessionIds.add(sid);
    all.push({ timestamp: obj.timestamp, event_type: type, data: obj.data || {} });
  }

  // Convert Sets to arrays (last 3 sessions per type)
  const serialized = {};
  for (const [type, entry] of Object.entries(eventsByType)) {
    serialized[type] = {
      count: entry.count,
      lastSeen: entry.lastSeen,
      sampleSessionIds: [...entry.sampleSessionIds].slice(-3),
    };
  }

  // Most recent N events (assumes JSONL is append-ordered — true in practice)
  const recent = all.slice(-recentLimit).reverse();

  return {
    eventsByType: serialized,
    recent,
    total: all.length,
    oldest,
    newest,
    sourcePath: EVENTS_PATH,
  };
}

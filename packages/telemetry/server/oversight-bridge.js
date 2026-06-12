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
import { existsSync, statSync, createReadStream } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import chokidar from 'chokidar';
import { FILE_POLL_INTERVAL_MS, WRITE_STABILITY_MS, WRITE_POLL_MS } from './config.js';

const HOME = process.env.HOME || process.env.USERPROFILE || homedir();
const EVENTS_PATH = join(HOME, '.claude', 'oversight-events.jsonl');

/**
 * Normalize one parsed JSONL line into { timestamp, event_type, data }.
 *
 * Hardens against the double-wrapped shape a buggy writer produced 2026-06-11
 * (scribe-db.js passed a whole {event_type, data} object as the eventType
 * argument): if event_type is an object, unwrap its inner event_type/data.
 * A non-string event_type must never reach the client — React crashes
 * rendering objects (error #31), which blanked the entire v2 Oversight
 * surface on real data.
 */
function normalizeEvent(obj) {
  let type = obj.event_type;
  let data = obj.data || {};
  if (type && typeof type === 'object') {
    if (typeof type.event_type === 'string') {
      data = type.data && typeof type.data === 'object' ? type.data : data;
      type = type.event_type;
    } else {
      type = 'unknown';
    }
  }
  if (typeof type !== 'string' || !type) type = 'unknown';
  return { timestamp: obj.timestamp, event_type: type, data };
}

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
    const evt = normalizeEvent(obj);
    const ts = evt.timestamp ? new Date(evt.timestamp).getTime() : null;
    if (oldest === null || (ts && ts < oldest)) oldest = ts;
    if (newest === null || (ts && ts > newest)) newest = ts;
    if (ts && ts < sinceMs) continue;
    const type = evt.event_type;
    if (!eventsByType[type]) {
      eventsByType[type] = { count: 0, lastSeen: null, sampleSessionIds: new Set() };
    }
    eventsByType[type].count++;
    if (!eventsByType[type].lastSeen || (ts && ts > eventsByType[type].lastSeen)) {
      eventsByType[type].lastSeen = ts;
    }
    const sid = evt.data?.session_id;
    if (sid) eventsByType[type].sampleSessionIds.add(sid);
    all.push(evt);
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

/**
 * Real-time push for oversight events (replaces poll-only consumption).
 *
 * Watches oversight-events.jsonl with the same polling settings as the other
 * telemetry watchers (Windows/OneDrive convention), tracks a byte offset, and
 * invokes `onEvents(parsedNewEvents)` for each appended batch. Only complete
 * lines (terminated by \n) are consumed — a partially-written tail line stays
 * unconsumed until the writer finishes it, so no event is ever half-parsed.
 *
 * Truncation/rotation (size shrinks below the tracked offset) resets the
 * offset to 0 and re-emits the file from the start.
 *
 * Returns the chokidar watcher (call .close() to stop).
 */
export function startOversightWatcher(onEvents) {
  let offset = 0;
  try {
    offset = statSync(EVENTS_PATH).size; // start at EOF — history is served by readOversightEvents
  } catch {
    offset = 0; // file doesn't exist yet — first append delivers from byte 0
  }

  let draining = false;
  const drain = async () => {
    if (draining) return;
    draining = true;
    try {
      let size;
      try {
        size = statSync(EVENTS_PATH).size;
      } catch {
        return; // file vanished — keep offset, wait for re-add
      }
      if (size < offset) offset = 0; // truncated or rotated
      if (size === offset) return;

      let buf = '';
      const stream = createReadStream(EVENTS_PATH, { start: offset, end: size - 1, encoding: 'utf8' });
      for await (const chunk of stream) buf += chunk;

      const lastNl = buf.lastIndexOf('\n');
      if (lastNl === -1) return; // no complete line yet — don't advance
      const complete = buf.slice(0, lastNl + 1);
      offset += Buffer.byteLength(complete, 'utf8');

      const events = [];
      for (const line of complete.split('\n')) {
        if (!line.trim()) continue;
        try {
          events.push(normalizeEvent(JSON.parse(line)));
        } catch {
          continue; // corrupt line — skip
        }
      }
      if (events.length) onEvents(events);
    } finally {
      draining = false;
    }
  };

  const watcher = chokidar.watch(EVENTS_PATH, {
    usePolling: true,
    interval: FILE_POLL_INTERVAL_MS,
    awaitWriteFinish: {
      stabilityThreshold: WRITE_STABILITY_MS,
      pollInterval: WRITE_POLL_MS,
    },
    ignoreInitial: true,
  });
  watcher.on('add', drain);
  watcher.on('change', drain);
  console.log(`[oversight] watching ${EVENTS_PATH}`);
  return watcher;
}

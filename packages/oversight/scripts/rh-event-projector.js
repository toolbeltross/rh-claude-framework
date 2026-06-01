#!/usr/bin/env node
// rh-event-projector.js
//
// Back-fills `layer3a_rejection` events into ~/.claude/oversight-events.jsonl
// from two retroactive sources:
//
//   1. supervisory-log.md Layer3a-rejection rows  (truncated reasons; reliable
//      timestamps; format set by rh-layer3a-capture.js)
//   2. session transcripts under ~/.claude/projects/<workspace>/*.jsonl, mtime
//      within the last 30 days (full reasons; same chunked-backwards reader
//      used in the capture script's fallback path)
//
// Idempotent. Builds a dedup set from existing layer3a_rejection events in the
// log keyed by (session_id_short, ISO timestamp truncated to seconds), so
// re-running this script does not double-emit. Truncated supervisor-log
// reasons are reconciled with full-text transcript reasons via the timestamp
// key, not content hash.
//
// Usage:
//   node rh-event-projector.js              # project both sources
//   node rh-event-projector.js --dry-run    # show counts without writing
//   node rh-event-projector.js --source=log # supervisor-log only
//   node rh-event-projector.js --source=transcripts  # transcripts only
//
// Exit code: 0 on success; non-zero on hard read failure of the events log.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { config } = require('./lib/config');

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const SOURCE_ARG = (argv.find(a => a.startsWith('--source=')) || '').split('=')[1] || 'both';
const SCAN_LOG = SOURCE_ARG === 'both' || SOURCE_ARG === 'log';
const SCAN_TRANSCRIPTS = SOURCE_ARG === 'both' || SOURCE_ARG === 'transcripts';

const EVENTS_LOG_PATH = config.eventsLogPath;
const SUPERVISORY_LOG_PATH = config.oversightLogPath;
const PROJECTS_DIR = path.join(config.claudeDir, 'projects');
const TRANSCRIPT_AGE_LIMIT_MS = 30 * 24 * 3600 * 1000;

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

function nowMs() { return Date.now(); }

function makeTimestampKey(sessionShort, isoTimestamp) {
  // Truncate ISO timestamp to seconds: "2026-05-31T09:57:53"
  const trimmed = isoTimestamp.replace(/\.\d+Z?$/, '').replace(/Z?$/, '');
  return `${sessionShort}|${trimmed}`;
}

function makeContentHash(sessionId, reason) {
  // Mirrors the formula in lib/oversight-events.js's appendOversightEvent so
  // a projector candidate sourced from a transcript (full reason text) hashes
  // identically to whatever the live capture wrote with the same input.
  const data = { reason, session_id: sessionId };
  const dataStr = JSON.stringify(data, Object.keys(data).sort());
  return crypto.createHash('sha256').update(dataStr).digest('hex');
}

// Returns {timestampKeys, contentHashCounts, totalCount} from the existing
// events log. Two dedup channels are needed because the two projector sources
// differ:
//
//   - Supervisor-log rows are written by the same script that emits the live
//     event, at the same instant — second-precision timestamp matches.
//     Reason text is truncated to 400 chars in the log, so its content_hash
//     does NOT match the live event's content_hash. Dedup by timestamp.
//
//   - Transcript "Stop hook feedback:" entries carry the FULL reason exactly
//     as the live capture stored it, but their `timestamp` field is when the
//     feedback was injected into the conversation — seconds-to-minutes
//     before the live event's emit timestamp. Content_hash matches; second-
//     truncated timestamp does not.
//
//     content_hash is NOT unique per event — two distinct Stop events with
//     identical (session_id, reason) produce identical content_hash (Claude
//     doubling down on the same violation produces two genuine data points
//     with the same content). Count occurrences so that if M same-text
//     entries appear in the transcript and N already exist as live events,
//     we project max(M - N, 0) — preserving the doubled-down multiplicity
//     while avoiding double-writes for what was already captured live.
function loadExistingKeys() {
  const timestampKeys = new Set();
  const contentHashCounts = new Map();
  let totalCount = 0;
  if (!fs.existsSync(EVENTS_LOG_PATH)) return { timestampKeys, contentHashCounts, totalCount };
  const content = fs.readFileSync(EVENTS_LOG_PATH, 'utf8');
  for (const line of content.split('\n')) {
    if (!line) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev?.event_type !== 'layer3a_rejection') continue;
    const sessionShort = String(ev?.data?.session_id || '').slice(0, 8);
    const ts = ev?.timestamp || '';
    if (ts) timestampKeys.add(makeTimestampKey(sessionShort, ts));
    if (ev?.content_hash) {
      contentHashCounts.set(ev.content_hash, (contentHashCounts.get(ev.content_hash) || 0) + 1);
    }
    totalCount++;
  }
  return { timestampKeys, contentHashCounts, totalCount };
}

function buildEvent({ isoTimestamp, sessionId, reason }) {
  const content_hash = makeContentHash(sessionId, reason);
  return {
    timestamp: isoTimestamp,
    event_type: 'layer3a_rejection',
    data: { session_id: sessionId, reason },
    content_hash,
  };
}

function appendEvents(events) {
  if (!events.length) return;
  if (DRY_RUN) return;
  const dir = path.dirname(EVENTS_LOG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const body = events.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.appendFileSync(EVENTS_LOG_PATH, body, 'utf8');
}

// ────────────────────────────────────────────────────────────
// Source 1: supervisory-log.md rows
// Row format set by rh-layer3a-capture.js:
//   - **2026-05-31 09:57:53** | `d82b184a` | Layer3a-rejection | <reason>
// Reason is truncated to 400 chars. Timestamp is UTC, no Z.
// ────────────────────────────────────────────────────────────

const LOG_ROW_RE =
  /^- \*\*(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\*\* \| `([^`]+)` \| Layer3a-rejection \| (.+)$/;

function scanSupervisoryLog() {
  if (!SCAN_LOG) return [];
  if (!fs.existsSync(SUPERVISORY_LOG_PATH)) {
    console.warn(`[projector] supervisory-log not found: ${SUPERVISORY_LOG_PATH}`);
    return [];
  }
  const out = [];
  const content = fs.readFileSync(SUPERVISORY_LOG_PATH, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const m = LOG_ROW_RE.exec(line);
    if (!m) continue;
    const [, date, time, sessionShort, reason] = m;
    const isoTimestamp = `${date}T${time}.000Z`;
    out.push({
      isoTimestamp,
      sessionId: sessionShort,
      sessionShort,
      reason,
      origin: 'supervisory_log',
    });
  }
  return out;
}

// ────────────────────────────────────────────────────────────
// Source 2: project transcripts
// Walk each ~/.claude/projects/<workspace>/<uuid>.jsonl modified within
// the last 30 days, find "Stop hook feedback:" user-role entries, extract
// rejection reasons matching the same pattern the capture script uses.
// ────────────────────────────────────────────────────────────

function isRejectionReason(s) {
  return /^(\[?Rule\s+\d|loop-break)/i.test(s);
}

function extractReason(content) {
  if (typeof content !== 'string') return null;
  if (!content.startsWith('Stop hook feedback:')) return null;
  const sep = content.lastIndexOf(']:');
  if (sep === -1) return null;
  const reason = content.slice(sep + 2).trim();
  if (!reason) return null;
  if (!isRejectionReason(reason)) return null;
  return reason;
}

function scanTranscript(transcriptPath) {
  // Forward streaming-read is fine here (projector is offline). We want ALL
  // rejection entries in the file, not just the most recent. Iterate lines
  // top-to-bottom.
  const out = [];
  let content;
  try {
    content = fs.readFileSync(transcriptPath, 'utf8');
  } catch { return out; }
  const sessionId = path.basename(transcriptPath, '.jsonl');
  const sessionShort = sessionId.slice(0, 8);
  for (const line of content.split('\n')) {
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type !== 'user') continue;
    const reason = extractReason(entry?.message?.content);
    if (!reason) continue;
    // Prefer the entry's own timestamp; fall back to file mtime if missing.
    let isoTimestamp = entry?.timestamp || null;
    if (!isoTimestamp) {
      try {
        isoTimestamp = new Date(fs.statSync(transcriptPath).mtimeMs).toISOString();
      } catch { isoTimestamp = new Date().toISOString(); }
    }
    out.push({
      isoTimestamp,
      sessionId,
      sessionShort,
      reason,
      origin: 'transcript',
    });
  }
  return out;
}

function scanAllTranscripts() {
  if (!SCAN_TRANSCRIPTS) return [];
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  const cutoffMs = nowMs() - TRANSCRIPT_AGE_LIMIT_MS;
  const out = [];
  let scanned = 0;
  let matched = 0;
  const workspaces = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory()).map(d => d.name);
  for (const ws of workspaces) {
    const wsDir = path.join(PROJECTS_DIR, ws);
    let files;
    try {
      files = fs.readdirSync(wsDir).filter(f => f.endsWith('.jsonl'));
    } catch { continue; }
    for (const f of files) {
      const full = path.join(wsDir, f);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (stat.mtimeMs < cutoffMs) continue;
      scanned++;
      const rows = scanTranscript(full);
      if (rows.length) matched++;
      for (const r of rows) out.push(r);
    }
  }
  console.warn(`[projector] scanned ${scanned} transcripts, ${matched} contained rejections`);
  return out;
}

// ────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────

function main() {
  const { timestampKeys, contentHashCounts, totalCount } = loadExistingKeys();

  const logCandidates = scanSupervisoryLog();
  const transcriptCandidates = scanAllTranscripts();

  // Supervisor-log source: dedup by (session_short, second-truncated ISO).
  // Each existing event came from a distinct emit, with a distinct second-
  // precision timestamp; log row timestamps from the same script match 1:1.
  const fresh = [];
  for (const c of logCandidates) {
    const tsKey = makeTimestampKey(c.sessionShort, c.isoTimestamp);
    if (timestampKeys.has(tsKey)) continue;
    fresh.push(c);
    // Reserve this key so two log candidates at the same second don't both
    // pass (rare, but defensive).
    timestampKeys.add(tsKey);
  }

  // Transcript source: count-based dedup.
  // Group transcript candidates by content_hash; for each group, project
  // max(transcriptCount - existingCount, 0). Preserves doubled-down
  // multiplicity across distinct Stop events while suppressing what's
  // already captured live. Iterating in transcript order means earlier
  // entries are emitted preferentially when partial overlap occurs.
  const transcriptByHash = new Map();
  for (const c of transcriptCandidates) {
    const ch = makeContentHash(c.sessionId, c.reason);
    if (!transcriptByHash.has(ch)) transcriptByHash.set(ch, []);
    transcriptByHash.get(ch).push(c);
  }
  for (const [ch, list] of transcriptByHash) {
    const existingN = contentHashCounts.get(ch) || 0;
    const toEmit = list.length > existingN ? list.slice(existingN) : [];
    for (const c of toEmit) fresh.push(c);
  }

  const events = fresh.map(buildEvent);

  console.warn(`[projector] existing layer3a_rejection events: ${totalCount}`);
  console.warn(`[projector] candidates surfaced: ${logCandidates.length + transcriptCandidates.length} (log=${logCandidates.length}, transcript=${transcriptCandidates.length})`);
  console.warn(`[projector] new events to append: ${events.length} (dry-run=${DRY_RUN})`);

  appendEvents(events);

  const originCounts = fresh.reduce((acc, c) => {
    acc[c.origin] = (acc[c.origin] || 0) + 1;
    return acc;
  }, {});
  for (const [origin, n] of Object.entries(originCounts)) {
    console.warn(`[projector]   from ${origin}: ${n}`);
  }
}

try {
  main();
  process.exit(0);
} catch (e) {
  console.error(`[projector] FAILED: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
}

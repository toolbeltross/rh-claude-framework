// lib/scribe-staging.js
//
// Per-session staging file for scribe coverage beyond the 10K-char tail.
//
// Origin: 2026-05-08 plan P1-3. The inline prefilter reads only the last
// 10,000 chars of the JSONL transcript on each Stop. Turns larger than that
// (or content earlier in a multi-turn session) is silently dropped — confirmed
// gap when /rh-quit runs on a long session.
//
// Fix: on each Stop, capture exactly the bytes appended to the transcript
// since the previous Stop (delta = currentSize - lastOffset) and write the
// extracted assistant text to a per-session JSONL staging file. /rh-quit's
// multiscope agent then reads the full staging file (not the 10K tail) for
// session-end true-up.
//
// Why offset-delta and not "read full transcript every Stop":
//   - Transcripts can be many MB by session end; reading them every Stop is
//     expensive and quadratic.
//   - Offset-delta is O(turn size) per Stop, regardless of session length.
//
// Caps (defensive — staging is NOT meant to be storage of last resort):
//   - TURN_CHAR_CAP: a single appended turn is truncated past this with a
//     marker. Protects against a single absurd turn (e.g., a model that
//     prints 5MB of JSON).
//   - SESSION_FILE_CAP: once the staging file exceeds this, further appends
//     are rejected (returns 0). Avoids unbounded growth from runaway loops.
//
// Migration safety (P1-3 staged rollout):
//   This lib is only INVOKED when staging is enabled via env var
//   RH_SCRIBE_STAGING=1 or oversight.json `scribeStaging:true`. With the
//   flag off, prefilter behaves exactly as before. The staging path runs
//   ALONGSIDE the existing inline extraction — it does not replace it.

const fs = require('fs');
const path = require('path');
const { config } = require('./config');

const TURN_CHAR_CAP = 500_000;          // 500KB per turn
const SESSION_FILE_CAP = 10 * 1024 * 1024;  // 10MB per session
const STAGING_DIR_NAME = 'scribe-staging';
const STAGING_TTL_MS = 7 * 24 * 60 * 60 * 1000;  // 7 days

function stagingDir() {
  return path.join(config.claudeDir, STAGING_DIR_NAME);
}

function ensureStagingDir() {
  const dir = stagingDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

function safeSid(sessionId) {
  return String(sessionId || 'nosid').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64);
}

function stagingPath(sessionId) {
  return path.join(stagingDir(), `staging-${safeSid(sessionId)}.jsonl`);
}

function offsetPath(sessionId) {
  return path.join(stagingDir(), `offset-${safeSid(sessionId)}.json`);
}

// Read the byte offset we last read up to in the transcript for this session.
// Returns { offset, transcriptSize } — transcriptSize is what stat.size was at
// the time of the last writeOffset, used to detect file-shrink/rewrite. Both
// default to 0 if the file is missing or unreadable.
function readOffset(sessionId) {
  try {
    const data = JSON.parse(fs.readFileSync(offsetPath(sessionId), 'utf8'));
    return {
      offset: Number.isFinite(data?.offset) ? data.offset : 0,
      transcriptSize: Number.isFinite(data?.transcriptSize) ? data.transcriptSize : 0,
    };
  } catch { return { offset: 0, transcriptSize: 0 }; }
}

function writeOffset(sessionId, offset, transcriptPath) {
  try {
    ensureStagingDir();
    let transcriptSize = 0;
    if (transcriptPath) {
      try { transcriptSize = fs.statSync(transcriptPath).size; } catch {}
    }
    fs.writeFileSync(
      offsetPath(sessionId),
      JSON.stringify({
        offset,
        transcriptSize,
        transcriptPath: transcriptPath || null,
        ts: Date.now(),
      }),
      'utf8'
    );
  } catch {}
}

// Read the bytes appended to the transcript since the last offset.
// Returns { text: '<new bytes utf8>', newOffset: <number>, advanced: <bool> }.
// Resets to read from 0 when the file has shrunk OR been rewritten to the
// same size (detected via stored transcriptSize from the prior writeOffset).
function readDelta(transcriptPath, sessionId) {
  if (!transcriptPath) return { text: '', newOffset: 0, advanced: false };
  let stat;
  try { stat = fs.statSync(transcriptPath); } catch { return { text: '', newOffset: 0, advanced: false }; }
  const prior = readOffset(sessionId);
  let offset = prior.offset;
  // Rewrite detection: the file is smaller than (or equal to but shifted from)
  // the last recorded size — caller likely truncated and started over. Reset.
  if (prior.transcriptSize > 0 && stat.size < prior.transcriptSize) offset = 0;
  if (offset > stat.size) offset = 0;
  if (offset === stat.size) return { text: '', newOffset: offset, advanced: false };
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    const len = stat.size - offset;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, offset);
    fs.closeSync(fd);
    return { text: buf.toString('utf8'), newOffset: stat.size, advanced: true };
  } catch {
    return { text: '', newOffset: offset, advanced: false };
  }
}

// Extract assistant text from a JSONL chunk (same shape as prefilter's extractText
// with onlyAssistant=true, kept local to avoid a circular dep). Returns concatenated
// assistant message text from the chunk.
function extractAssistantText(rawChunk) {
  if (!rawChunk) return '';
  const lines = rawChunk.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    if (!line || line[0] !== '{') continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const m = msg?.message || msg;
    if (m?.role !== 'assistant') continue;
    const content = m?.content;
    if (typeof content === 'string') out.push(content);
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string') out.push(block.text);
      }
    }
  }
  return out.join('\n');
}

// Append a turn to the staging file. Returns the number of chars actually written
// (0 if skipped). Truncates per-turn if too large; rejects entirely if the file
// is already at or above SESSION_FILE_CAP.
function appendTurn(sessionId, assistantText, meta = {}) {
  if (!sessionId || !assistantText) return 0;
  ensureStagingDir();
  const fp = stagingPath(sessionId);
  let existingSize = 0;
  try { existingSize = fs.statSync(fp).size; } catch {}
  if (existingSize >= SESSION_FILE_CAP) return 0;
  let text = assistantText;
  let truncated = false;
  if (text.length > TURN_CHAR_CAP) {
    text = text.slice(0, TURN_CHAR_CAP) + '\n…[truncated at TURN_CHAR_CAP]';
    truncated = true;
  }
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    sid: safeSid(sessionId).slice(0, 8),
    chars: text.length,
    truncated,
    ...meta,
    text,
  }) + '\n';
  try {
    fs.appendFileSync(fp, line, 'utf8');
    return text.length;
  } catch {
    return 0;
  }
}

// Read all staged turns for a session. Returns an array of records in the order
// they were written. Missing file returns [].
function readSession(sessionId) {
  const fp = stagingPath(sessionId);
  let raw;
  try { raw = fs.readFileSync(fp, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line[0] !== '{') continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

// Concatenate all assistant text from staged turns for this session, ordered.
function readSessionText(sessionId) {
  return readSession(sessionId).map(r => r?.text || '').filter(Boolean).join('\n\n');
}

// Delete the staging file + offset for a session. Called by /rh-quit after the
// multiscope agent has consumed the staged content.
function clearSession(sessionId) {
  try { fs.unlinkSync(stagingPath(sessionId)); } catch {}
  try { fs.unlinkSync(offsetPath(sessionId)); } catch {}
}

// Prune staging files older than maxAgeMs. Called by rh-auto-prune.
// Returns { stagingRemoved, offsetRemoved }.
function pruneStale(maxAgeMs = STAGING_TTL_MS) {
  const dir = stagingDir();
  let stagingRemoved = 0;
  let offsetRemoved = 0;
  let names;
  try { names = fs.readdirSync(dir); } catch { return { stagingRemoved, offsetRemoved }; }
  const now = Date.now();
  for (const name of names) {
    if (!name.startsWith('staging-') && !name.startsWith('offset-')) continue;
    const fp = path.join(dir, name);
    let stat;
    try { stat = fs.statSync(fp); } catch { continue; }
    if (now - stat.mtimeMs <= maxAgeMs) continue;
    try {
      fs.unlinkSync(fp);
      if (name.startsWith('staging-')) stagingRemoved++;
      else offsetRemoved++;
    } catch {}
  }
  return { stagingRemoved, offsetRemoved };
}

// Feature-flag check. Returns true when staging is enabled for this run.
// On by default. Disable via RH_SCRIBE_STAGING=0 or oversight.json scribeStaging:false.
function isEnabled() {
  const env = process.env.RH_SCRIBE_STAGING;
  if (env === '1' || env === 'true') return true;
  if (env === '0' || env === 'false') return false;
  return config.scribeStaging === true;
}

module.exports = {
  isEnabled,
  stagingDir,
  stagingPath,
  offsetPath,
  readOffset,
  writeOffset,
  readDelta,
  extractAssistantText,
  appendTurn,
  readSession,
  readSessionText,
  clearSession,
  pruneStale,
  TURN_CHAR_CAP,
  SESSION_FILE_CAP,
  STAGING_TTL_MS,
};

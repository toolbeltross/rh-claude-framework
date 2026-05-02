// rh-scribe-prefilter.js
// Stop hook — inline regex extraction of recommendations and cleanup items.
// See original for full architecture notes (Option C, 2026-05-02).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { wrapHook } = require('./lib/hook-timing');
const { config } = require('./lib/config');

const HOME = config.home;
const TAIL_CAP = 10_000;
const SENTINEL = '<!-- scribe-done -->';
const FLAG_TTL_MS = 90_000;
const REC_FILE = path.join(config.workspace, 'recommendations.md');
const CLEAN_FILE = path.join(config.workspace, 'cleanup.md');
const MAX_SNIPPETS_PER_SCOPE = 5;
const SNIPPET_MAX_CHARS = 400;
const SNIPPET_MIN_CHARS = 30;
const LOCK_RETRIES = 30;
const LOCK_BASE_WAIT_MS = 40;

const REQUIRED_AGENTS = ['rh-scribe-recommendations', 'rh-scribe-cleanup-items'];

const BACKOFF_THRESHOLD = 3;
const BACKOFF_WINDOW_MS = 10 * 60_000;
const BACKOFF_SUPPRESS_MS = 30 * 60_000;
const STATE_FILE = path.join(config.claudeDir, 'scribe-session-state.json');

const PRIVACY_PATTERNS = config.privateDirs.length > 0
  ? config.privateDirs.map(d => new RegExp(d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\\\/]', 'i'))
  : [/Personal[\\/]/i, /Financial[\\/]/i, /\b(CS2025|archive-cs2025)\b/i, /\bTroy2023\b/i, /\bDivorce\b/i];

const REC_MARKERS = /\b(recommend(?:ation|s|ed)?|should|consider|would be better|improve|suggest(?:ion)?)\b/i;
const CLEANUP_MARKERS = /\b(TODO|FIXME|leftover|stale|cleanup|temporary|orphan|dead code|remove later)\b/i;
const LEARNINGS_MARKERS = /\b(learned|established|the pattern is|going forward|new concept|distinguish between|taxonomy|vocabulary|technique|methodology|decision rule)\b/i;

function readTranscriptTail(transcriptPath) {
  if (!transcriptPath) return '';
  try {
    const stat = fs.statSync(transcriptPath);
    const fd = fs.openSync(transcriptPath, 'r');
    const start = Math.max(0, stat.size - TAIL_CAP);
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch { return ''; }
}

function extractText(rawTail, onlyAssistant = false) {
  if (!rawTail) return '';
  const lines = rawTail.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    if (!line || line[0] !== '{') continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const m = msg?.message || msg;
    const role = m?.role;
    if (onlyAssistant) { if (role !== 'assistant') continue; }
    else { if (role !== 'assistant' && role !== 'user') continue; }
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

function extractAssistantText(rawTail) { return extractText(rawTail, false); }

function turnHash(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function splitSentences(text) {
  const paragraphs = text.split(/\n\s*\n+/);
  const out = [];
  for (const p of paragraphs) {
    const lines = p.split(/\n/).map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      const parts = line.split(/(?<=[.!?])\s+(?=[A-Z(\["'])/);
      for (const part of parts) {
        const t = part.trim();
        if (t) out.push(t);
      }
    }
  }
  return out;
}

function extractSnippets(text, markerRegex) {
  const sentences = splitSentences(text);
  const snippets = [];
  const seen = new Set();
  for (const s of sentences) {
    if (snippets.length >= MAX_SNIPPETS_PER_SCOPE) break;
    if (!markerRegex.test(s)) continue;
    let trimmed = s.replace(/\s+/g, ' ').trim();
    if (trimmed.length < SNIPPET_MIN_CHARS) continue;
    if (trimmed.length > SNIPPET_MAX_CHARS) trimmed = trimmed.slice(0, SNIPPET_MAX_CHARS - 1) + '…';
    trimmed = trimmed.replace(/\|/g, '\\|');
    const id = crypto.createHash('sha1').update(trimmed).digest('hex').slice(0, 10);
    if (seen.has(id)) continue;
    seen.add(id);
    snippets.push({ id, text: trimmed });
  }
  return snippets;
}

function buildRow(id, sessionId, snippet) {
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const sid = (sessionId || 'unknown').slice(0, 8);
  return `| ${id} | ${ts} | ${sid} | ${snippet} | open |\n`;
}

function appendRowsToFile(filePath, rows) {
  if (!rows.length) return 0;
  const lockPath = filePath + '.lock';
  for (let i = 0; i < LOCK_RETRIES; i++) {
    let acquired = false;
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      acquired = true;
    } catch {
      try {
        const lockAge = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (lockAge > 5000) { try { fs.unlinkSync(lockPath); } catch {} }
      } catch {}
    }
    if (!acquired) {
      const wait = LOCK_BASE_WAIT_MS * (1 + i) + Math.floor(Math.random() * LOCK_BASE_WAIT_MS);
      const start = Date.now();
      while (Date.now() - start < wait) {}
      continue;
    }
    try {
      const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
      const sentinelIdx = content.lastIndexOf(SENTINEL);
      const trailingAfterSentinel = sentinelIdx >= 0 ? content.slice(sentinelIdx + SENTINEL.length).trim() : '';
      let newContent;
      if (sentinelIdx >= 0 && trailingAfterSentinel === '') {
        const head = content.slice(0, sentinelIdx).replace(/\n+$/, '\n');
        newContent = head + rows.join('') + SENTINEL + '\n';
      } else {
        const tail = content.endsWith('\n') ? '' : '\n';
        newContent = content + tail + rows.join('') + SENTINEL + '\n';
      }
      fs.writeFileSync(filePath, newContent, 'utf8');
      return rows.length;
    } catch {
      return 0;
    } finally {
      try { fs.unlinkSync(lockPath); } catch {}
    }
  }
  return 0;
}

function flagPath(sessionId) {
  return path.join(config.claudeDir, `scribe-pending-${(sessionId || 'nosid').slice(0, 32)}.flag`);
}

function flagFresh(filePath, currentHash) {
  try {
    const stat = fs.statSync(filePath);
    if (Date.now() - stat.mtimeMs > FLAG_TTL_MS) return false;
    return fs.readFileSync(filePath, 'utf8').trim() === currentHash;
  } catch { return false; }
}

function writeFlag(filePath, hash) {
  try { fs.writeFileSync(filePath, hash, 'utf8'); } catch {}
}

function scribesLoadedAtSessionStart(sessionId) {
  if (!sessionId) return true;
  const marker = readSessionMarker(sessionId);
  if (!marker) return true;
  const startedAt = marker?.startedAt ? Date.parse(marker.startedAt) : 0;
  const agents = marker?.agents || {};
  for (const name of REQUIRED_AGENTS) {
    const recordedMtime = agents[name];
    if (!recordedMtime) return false;
    if (Date.parse(recordedMtime) > startedAt + 5_000) return false;
  }
  return true;
}

function agentLoadedAtSessionStart(sessionId, agentName) {
  if (!sessionId) return true;
  const marker = readSessionMarker(sessionId);
  if (!marker) return true;
  const startedAt = marker?.startedAt ? Date.parse(marker.startedAt) : 0;
  const agents = marker?.agents || {};
  const recordedMtime = agents[agentName];
  if (!recordedMtime) return false;
  if (Date.parse(recordedMtime) > startedAt + 5_000) return false;
  return true;
}

function readSessionMarker(sessionId) {
  const safe = sessionId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64);
  const fp = path.join(config.claudeDir, `session-marker-${safe}.json`);
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8'); } catch {}
}

function backoffCheck(sessionId) {
  if (!sessionId) return { suppressed: false, recordBlock: () => {} };
  const state = loadState();
  const now = Date.now();
  for (const sid of Object.keys(state)) {
    const e = state[sid] || {};
    const blocks = (e.blocks || []).filter(t => now - t < BACKOFF_WINDOW_MS);
    const stillSuppressed = e.suppressUntil && e.suppressUntil > now;
    if (blocks.length === 0 && !stillSuppressed) delete state[sid];
    else state[sid] = { blocks, suppressUntil: stillSuppressed ? e.suppressUntil : 0 };
  }
  const entry = state[sessionId] || { blocks: [], suppressUntil: 0 };
  if (entry.suppressUntil && entry.suppressUntil > now) {
    saveState(state);
    return { suppressed: true, recordBlock: () => {} };
  }
  return {
    suppressed: false,
    recordBlock: () => {
      entry.blocks = (entry.blocks || []).filter(t => now - t < BACKOFF_WINDOW_MS);
      entry.blocks.push(now);
      if (entry.blocks.length >= BACKOFF_THRESHOLD) {
        entry.suppressUntil = now + BACKOFF_SUPPRESS_MS;
        entry.blocks = [];
      }
      state[sessionId] = entry;
      saveState(state);
    }
  };
}

wrapHook('scribe-prefilter', (input) => {
  const transcriptPath = input?.transcript_path;
  const sessionId = input?.session_id || '';

  const raw = readTranscriptTail(transcriptPath);
  if (!raw) return {};

  const text = extractAssistantText(raw);
  if (!text || text.length < 50) return {};

  if (text.includes(SENTINEL)) return {};
  if (PRIVACY_PATTERNS.some(re => re.test(text))) return {};

  const hasRec = REC_MARKERS.test(text);
  const hasCleanup = CLEANUP_MARKERS.test(text);
  const hasLearnings = LEARNINGS_MARKERS.test(text);
  if (!hasRec && !hasCleanup && !hasLearnings) return {};

  if (!scribesLoadedAtSessionStart(sessionId)) return {};

  const hash = turnHash(text);
  const fp = flagPath(sessionId);
  if (flagFresh(fp, hash)) return {};

  const bo = backoffCheck(sessionId);
  if (bo.suppressed) return {};
  bo.recordBlock();

  writeFlag(fp, hash);

  const assistantOnly = extractText(raw, true);
  let totalAppended = 0;
  if (hasRec && assistantOnly) {
    const rows = extractSnippets(assistantOnly, REC_MARKERS).map(s => buildRow(s.id, sessionId, s.text));
    totalAppended += appendRowsToFile(REC_FILE, rows);
  }
  if (hasCleanup && assistantOnly) {
    const rows = extractSnippets(assistantOnly, CLEANUP_MARKERS).map(s => buildRow(s.id, sessionId, s.text));
    totalAppended += appendRowsToFile(CLEAN_FILE, rows);
  }

  try {
    const telemetry = path.join(config.claudeDir, 'rh-scribe-inline.jsonl');
    fs.appendFileSync(telemetry, JSON.stringify({
      ts: new Date().toISOString(), sid: (sessionId || '').slice(0, 8),
      hasRec, hasCleanup, hasLearnings, appended: totalAppended
    }) + '\n');
  } catch {}

  return {};
}, { hookType: 'Stop' });

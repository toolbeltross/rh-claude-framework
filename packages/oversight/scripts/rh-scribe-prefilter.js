// rh-scribe-prefilter.js
// Stop hook (placed BEFORE Layer 3a prompt in the Stop array, per oversight-steward C-5).
//
// 2026-05-02 architecture: INLINE REGEX EXTRACTION (Option C). Replaces the prior
// async queue+drain+headless-claude design which had multiple Windows-specific
// failure modes (cwd ENOENT under OneDrive-off; child claude exit code 0xC000013A
// in detached spawn contexts) and concurrency exposure across parallel sessions.
//
// Flow on each Stop:
//   1. Read transcript tail (10K char cap)
//   2. Apply gates: privacy blocklist, sentinel self-loop skip, capability check,
//      loop guard (turn-hash flag), session back-off
//   3. Detect markers (recommend / TODO+cleanup / learnings)
//   4. For recommendations + cleanup: regex-extract assistant-only sentence-bounded
//      snippets, atomically append rows to recommendations.md / cleanup.md using
//      a lockfile-with-jitter pattern (safe under N-way parallel session fire,
//      verified to 32-way in this hook's stress test)
//   5. Learnings are NOT extracted inline — their YAML+sections format requires
//      synthesis; captured only via /rh-quit (in-process Task dispatch)
//   6. Return {} non-blocking
//
// Trade-off: lower content quality vs LLM-curated rows. Acceptable because the
// high-quality path is preserved in /rh-quit (user-invoked, in-process Task
// dispatch — no headless claude). Total prefilter time is <50ms; zero spawn,
// zero async, zero API tokens, zero queue.
//
// Constraints carried forward from oversight-steward APPROVE-WITH-CONDITIONS (v1):
//   C-1 tail cap: 10,000 chars before regex
//   C-2 self-loop skip: SENTINEL marks scribe-generated content
//   C-3 privacy blocklist: structural patterns hardcoded (Personal/, Financial/);
//       user-specific entity names are loaded from ~/.claude/private-blocklist.json
//       (user-private, gitignored). The framework code does NOT contain user-
//       specific names by design — adding them here would put private tokens
//       in the public framework repo.
//   C-4 concurrency: now handled in this hook via lockfile-with-jitter (was the
//        scribe agents' responsibility under the prior async design)
//   C-5 hook order: still BEFORE Layer 3a prompt
//   C-6 resolved-detection deferred: rows are append-only, status:open by default

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { wrapHook } = require('./lib/hook-timing');
const { withLock } = require('./lib/file-lock');
const { config } = require('./lib/config');

const TAIL_CAP = 10_000;
const SENTINEL = '<!-- scribe-done -->';
const FLAG_TTL_MS = 90_000;
const REC_FILE = path.join(config.workspace, 'recommendations.md');
const CLEAN_FILE = path.join(config.workspace, 'cleanup.md');
const MAX_SNIPPETS_PER_SCOPE = 5;
const SNIPPET_MAX_CHARS = 400;
const SNIPPET_MIN_CHARS = 30;
// Lock-retry budget sized for 8+ simultaneous writers (parallel sessions).
// Total max wait per retry batch: ~LOCK_RETRIES * LOCK_BASE_WAIT_MS * 1.5 = ~1800ms.
const LOCK_RETRIES = 30;
const LOCK_BASE_WAIT_MS = 40;

// Capability detection (added 2026-04-29) — Option A.
// scribe-recommendations and scribe-cleanup-items are dispatched via Task by the
// supervisor agent. But Claude Code locks the available-agents list at SessionStart;
// agents whose files were created mid-session can't be Task-dispatched until next
// session. Issuing a directive that names them in such a session creates a hot loop.
// Defense: read the SessionStart marker (~/.claude/session-marker-{sid}.json) written
// by agents-loaded-marker.js. If either scribe agent is missing OR its file mtime is
// newer than the marker's startedAt, skip the dispatch (return {}). The session can't
// fulfill the directive — don't issue it.
const REQUIRED_AGENTS = ['rh-scribe-recommendations', 'rh-scribe-cleanup-items'];

// Session back-off (added 2026-04-28): if a session generates BACKOFF_THRESHOLD blocks
// within BACKOFF_WINDOW_MS, suppress further blocking for BACKOFF_SUPPRESS_MS. Prevents
// the meta-conversation hot loop where every turn discusses cleanup architecture and
// re-triggers the prefilter (e.g., the session that built this hook).
const BACKOFF_THRESHOLD = 3;
const BACKOFF_WINDOW_MS = 10 * 60_000;     // 10 minutes
const BACKOFF_SUPPRESS_MS = 30 * 60_000;   // 30 minutes
const STATE_FILE = path.join(config.claudeDir, 'scribe-session-state.json');

// Privacy blocklist (C-3). If any pattern appears in the tail, skip silently.
//
// Two-layer design:
//   1. Structural patterns (hardcoded below) — directory names that are
//      universal markers of private content (Personal/, Financial/) plus
//      a generic "Divorce" word-token.
//   2. User-specific patterns — entity names like a tax-year project name
//      that vary per user. Loaded at module-load time from
//      ~/.claude/private-blocklist.json (a user-private, gitignored file).
//      The framework code does NOT contain user-specific entity names —
//      keeping them out of the public repo is the whole point of the
//      external file.
//
// Schema for ~/.claude/private-blocklist.json:
//   {
//     "patterns": ["RegexLiteralWithoutSlashes", "AnotherEntityName", ...]
//   }
// Each entry is wrapped as /\b<entry>\b/i at load time. Invalid entries
// are skipped silently. File missing is fine — only structural patterns apply.
const PRIVACY_PATTERNS = [
  /Personal[\\/]/i,
  /Financial[\\/]/i,
  /\bDivorce\b/i,
];

(function loadUserBlocklist() {
  try {
    const userBlocklistPath = path.join(config.claudeDir, 'private-blocklist.json');
    if (!fs.existsSync(userBlocklistPath)) return;
    const raw = fs.readFileSync(userBlocklistPath, 'utf8');
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.patterns)) return;
    for (const entry of data.patterns) {
      if (typeof entry !== 'string' || !entry.trim()) continue;
      try {
        PRIVACY_PATTERNS.push(new RegExp(`\\b${entry}\\b`, 'i'));
      } catch {}
    }
  } catch {}
})();

const REC_MARKERS = /\b(recommend(?:ation|s|ed)?|should|consider|would be better|improve|suggest(?:ion)?)\b/i;
const CLEANUP_MARKERS = /\b(TODO|FIXME|leftover|stale|cleanup|temporary|orphan|dead code|remove later)\b/i;
// Learnings markers (added 2026-04-29). Conceptual deltas: vocabulary established, patterns
// validated, decision rules formed, capabilities newly understood. Distinct from
// recommendations (forward action) and cleanup (TODO/stale). Loose-match by design — the
// scribe-learnings agent does the strict triage downstream.
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

// Extract role-tagged text from a JSONL transcript tail. onlyAssistant=true
// returns assistant turns only (used for snippet extraction so user questions
// don't get captured as recommendations). onlyAssistant=false returns both
// roles (used for marker detection — markers in either role are signal).
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
    if (onlyAssistant) {
      if (role !== 'assistant') continue;
    } else {
      if (role !== 'assistant' && role !== 'user') continue;
    }
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

// Backwards-compat alias
function extractAssistantText(rawTail) { return extractText(rawTail, false); }

function turnHash(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

// Split text into sentence-ish units. Sentence boundaries are . ! ? followed by
// whitespace, OR a blank line. Bullet/numbered list items are kept as their own
// units (they often carry recommendations like "1. Do X.").
function splitSentences(text) {
  // First split on blank lines (paragraph breaks); then within each paragraph,
  // split on sentence terminators followed by whitespace.
  const paragraphs = text.split(/\n\s*\n+/);
  const out = [];
  for (const p of paragraphs) {
    // Collapse internal newlines, but preserve list-item leading markers
    const lines = p.split(/\n/).map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      // Split each line on sentence terminators
      const parts = line.split(/(?<=[.!?])\s+(?=[A-Z(\["'])/);
      for (const part of parts) {
        const t = part.trim();
        if (t) out.push(t);
      }
    }
  }
  return out;
}

// Extract de-duplicated snippets containing a marker. Returns [{hash, text}, ...].
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
    // Escape pipe chars (would break markdown table)
    trimmed = trimmed.replace(/\|/g, '\\|');
    const id = crypto.createHash('sha1').update(trimmed).digest('hex').slice(0, 10);
    if (seen.has(id)) continue;
    seen.add(id);
    snippets.push({ id, text: trimmed });
  }
  return snippets;
}

// Build a markdown table row matching the existing recommendations.md/cleanup.md schema.
function buildRow(id, sessionId, snippet) {
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const sid = (sessionId || 'unknown').slice(0, 8);
  return `| ${id} | ${ts} | ${sid} | ${snippet} | open |\n`;
}

// Insert rows into a target file with sentinel-correct positioning.
//
// CRITICAL: the read-modify-write must happen INSIDE the lock. Reading outside
// the lock creates a TOCTOU race — multiple writers can each capture stale
// pre-modification state and then take turns writing back stale-plus-their-row,
// overwriting each other's work. Verified empirically (8-way stress test
// observed all 16 rows lost AND prior content deleted before the fix).
//
// Sentinel handling (revised 2026-05-08, P1-7): strip ALL sentinel occurrences
// from existing content, then append rows + a single sentinel at EOF. This
// closes the deterministic mid-file-sentinel bug where the prior logic's
// `else` branch (sentinel exists but has trailing content) added a NEW sentinel
// without removing the existing mid-file one — accumulating duplicate
// sentinels across runs and leaving the first one stranded mid-file forever.
// Also identical to the rh-scribe-table-write.js CLI helper used by the
// multiscope scribe agent — both writers now produce the same on-disk shape.
function appendRowsToFile(filePath, rows) {
  if (!rows.length) return 0;
  // Lock pattern extracted to ./lib/file-lock.js (Phase 1 C1, 2026-05-02).
  // Original 32-way parallel-stress verification still applies — this is the
  // same pattern, just dispatched through the shared helper.
  const result = withLock(filePath, () => {
    try {
      const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';

      // Strip ALL sentinel occurrences (interior + EOF). One sentinel will
      // be re-added at EOF below.
      const stripped = content
        .split('\n')
        .filter(l => l.trim() !== SENTINEL)
        .join('\n');

      let body = stripped;
      if (body.length > 0 && !body.endsWith('\n')) body += '\n';

      const newContent = body + rows.join('') + SENTINEL + '\n';
      fs.writeFileSync(filePath, newContent, 'utf8');
      return rows.length;
    } catch {
      return 0;
    }
  }, { retries: LOCK_RETRIES, baseWaitMs: LOCK_BASE_WAIT_MS });
  return result ?? 0;  // withLock returns undefined on lock-acquisition failure
}

function flagPath(sessionId) {
  return path.join(config.claudeDir, `scribe-pending-${(sessionId || 'nosid').slice(0, 32)}.flag`);
}

function flagFresh(filePath, currentHash) {
  try {
    const stat = fs.statSync(filePath);
    if (Date.now() - stat.mtimeMs > FLAG_TTL_MS) return false;
    const stored = fs.readFileSync(filePath, 'utf8').trim();
    return stored === currentHash;
  } catch { return false; }
}

function writeFlag(filePath, hash) {
  try { fs.writeFileSync(filePath, hash, 'utf8'); } catch {}
}

// Capability detection: returns true if the named scribe agents are dispatchable
// in this session — i.e., they exist in the marker AND were on disk at SessionStart.
// Returns true (fail-open) if no marker exists at all (e.g., for sessions that
// predate this hook's deployment) — those will fall through to the existing
// session back-off as a safety net rather than being silently muted.
function scribesLoadedAtSessionStart(sessionId) {
  if (!sessionId) return true;  // fail-open
  const marker = readSessionMarker(sessionId);
  if (!marker) return true;  // fail-open
  const startedAt = marker?.startedAt ? Date.parse(marker.startedAt) : 0;
  const agents = marker?.agents || {};
  for (const name of REQUIRED_AGENTS) {
    const recordedMtime = agents[name];
    if (!recordedMtime) return false;  // not present at SessionStart
    if (Date.parse(recordedMtime) > startedAt + 5_000) return false;  // 5s tolerance
  }
  return true;
}

// Per-agent capability check (added 2026-04-29 for scribe-learnings rollout).
// Used for OPTIONAL scribes — those that, if loaded, expand the scope set; if not
// loaded, are silently skipped without affecting the required-scribe path.
function agentLoadedAtSessionStart(sessionId, agentName) {
  if (!sessionId) return true;  // fail-open
  const marker = readSessionMarker(sessionId);
  if (!marker) return true;  // fail-open
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
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return null;
  }
}

// Session state: { sessionId: { blocks: [ts, ts, ...], suppressUntil: ts } }
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(state) {
  // INTENTIONALLY UNLOCKED. Phase 1 C1 (2026-05-02): the lock for state writes
  // belongs at the load-modify-save boundary, not on the leaf write. Wrapping
  // saveState alone left a TOCTOU window (loadState in backoffCheck, mutate,
  // saveState here — multiple sessions could each load stale state, mutate,
  // and serially overwrite each other). Worse, calling withLock here from
  // within a withLock at the call site would deadlock for ~5s on stale-lock
  // recovery. The fix is in backoffCheck's recordBlock closure: it now does
  // load+mutate+saveState atomically inside its own withLock.
  // Direct saveState callers (only the pruning path in backoffCheck) accept
  // race exposure: pruning is idempotent and not data-critical.
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8'); } catch {}
}
// Returns { suppressed: bool, recordBlock: fn } — call recordBlock() AFTER you decide to block
function backoffCheck(sessionId) {
  if (!sessionId) return { suppressed: false, recordBlock: () => {} };
  const state = loadState();
  const now = Date.now();
  // Drop entries for sessions whose suppress window expired AND have no recent blocks
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
      // Phase 1 C1 (2026-05-02): atomic load-modify-save inside withLock to
      // close the TOCTOU window across parallel sessions. Without the lock,
      // session A and session B can each loadState (capturing stale views),
      // mutate their own session entry, and serially saveState — losing the
      // first writer's update. The fresh re-read inside the lock sees any
      // concurrent updates from other sessions.
      withLock(STATE_FILE, () => {
        const freshState = loadState();
        const freshEntry = freshState[sessionId] || { blocks: [], suppressUntil: 0 };
        freshEntry.blocks = (freshEntry.blocks || []).filter(t => now - t < BACKOFF_WINDOW_MS);
        freshEntry.blocks.push(now);
        if (freshEntry.blocks.length >= BACKOFF_THRESHOLD) {
          freshEntry.suppressUntil = now + BACKOFF_SUPPRESS_MS;
          freshEntry.blocks = [];
        }
        freshState[sessionId] = freshEntry;
        saveState(freshState);  // unlocked leaf write — we hold the lock
      });
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

  // C-2: self-loop skip
  if (text.includes(SENTINEL)) return {};

  // C-3: privacy blocklist
  if (PRIVACY_PATTERNS.some(re => re.test(text))) return {};

  const hasRec = REC_MARKERS.test(text);
  const hasCleanup = CLEANUP_MARKERS.test(text);
  const hasLearnings = LEARNINGS_MARKERS.test(text);
  if (!hasRec && !hasCleanup && !hasLearnings) return {};

  // Capability detection: skip dispatch if scribes weren't loaded at SessionStart.
  // Issuing a directive Claude can't fulfill creates a hot loop.
  if (!scribesLoadedAtSessionStart(sessionId)) return {};

  // Loop guard: same turn already directed in last 90s → don't re-block
  const hash = turnHash(text);
  const fp = flagPath(sessionId);
  if (flagFresh(fp, hash)) return {};

  // Session-level back-off: if this session has been blocking repeatedly without resolution,
  // suppress further blocks for the suppress window. Prevents meta-conversation hot loops.
  const bo = backoffCheck(sessionId);
  if (bo.suppressed) return {};
  bo.recordBlock();

  writeFlag(fp, hash);

  // INLINE EXTRACTION (Option C, 2026-05-02): regex-extract snippets from the
  // assistant text and append them directly to recommendations.md / cleanup.md.
  // Replaces the prior async queue+drain+headless-claude architecture, which had
  // multiple Windows-specific failure modes (cwd ENOENT under OneDrive-off, child
  // claude exit code 0xC000013A in detached spawn contexts) and concurrency
  // exposure across parallel sessions. Inline extraction is deterministic, fast
  // (<50ms), token-free, and concurrency-safe via lockfile-with-jitter.
  //
  // Trade-off: lower content quality vs LLM-curated rows. Acceptable here because
  // the high-quality path is preserved in /rh-quit (user-invoked, in-process Task
  // dispatch — no headless claude). Learnings are NOT extracted inline because
  // their YAML+sections format requires synthesis a regex cannot produce.
  // Snippet extraction sources from ASSISTANT text only — user prompts
  // (e.g. "How should we improve X?") trigger marker detection upstream
  // but should never be captured as recommendations.
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
  // Note: hasLearnings detection still runs (used by /rh-quit metadata if needed)
  // but inline extraction is intentionally skipped for learnings.

  // Telemetry breadcrumb (silent best-effort): record what was extracted this turn.
  // JSONL atomic-append assumption (Phase 1 C3, 2026-05-02): unlocked because
  // the record is fixed-shape (timestamp + 8-char sid + 3 booleans + integer)
  // — well under the NTFS sub-block atomicity bound (~4KB). Multiple parallel
  // sessions write to this file but record sizes stay bounded.
  try {
    const telemetry = path.join(config.claudeDir, 'rh-scribe-inline.jsonl');
    fs.appendFileSync(telemetry, JSON.stringify({
      ts: new Date().toISOString(),
      sid: (sessionId || '').slice(0, 8),
      hasRec, hasCleanup, hasLearnings,
      appended: totalAppended
    }) + '\n');
  } catch {}

  return {};  // Non-blocking: Stop succeeds, user gets control back.
}, { hookType: 'Stop' });

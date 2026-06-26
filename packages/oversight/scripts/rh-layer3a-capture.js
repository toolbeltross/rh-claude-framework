// layer3a-capture.js
// Stop hook (runs after the Layer 3a prompt entry).
// Attempts to capture Layer 3a rejection reasons and persist them to
// supervisory-log.md so the supervisor can analyze rejection patterns
// across sessions (previously, rejections were visible only in-session
// as Stop-hook-feedback text and were lost when the session ended).
//
// Implementation note: this script is best-effort. Whether Claude Code
// passes the prompt-hook's JSON result to a subsequent command hook in
// the same Stop array is implementation-defined. If stdin doesn't carry
// a Layer 3a result, the script is a silent no-op. Either way it never
// blocks anything.
//
// Side-channel safety: appends are append-only writes to supervisory-log;
// failure to write is swallowed.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { appendOversightEvent } = require('./lib/oversight-events');
const { wrapHook } = require('./lib/hook-timing');
const { config } = require('./lib/config');

const OVERSIGHT_LOG_PATH = process.env.OVERSIGHT_LOG_PATH ||
  path.join(config.claudeDir, 'telemetry-supervisory-log.md');

// 2026-05-31 A2: dedup marker. F-J duplicate Stop hook means this script
// fires twice per Stop event with identical (session_id, reason). Marker
// records the SHA-256 of the most recent emitted (session_id, reason) AND
// the millisecond it was emitted. Re-emit is suppressed only when the hash
// matches AND the prior emit was within a short window (DEDUP_WINDOW_MS).
//
// Time-windowed dedup is required so this only catches F-J duplicates (which
// fire within milliseconds of each other on the same Stop event), NOT
// legitimate same-text rejections that recur across consecutive Stop events
// when Claude doubles down on a violation. The latter happens seconds-to-
// minutes apart and SHOULD all emit — each is a distinct loop-break data
// point and a distinct supervisor verdict.
const DEDUP_MARKER_PATH = path.join(config.claudeDir, '.layer3a-last-captured-hash');
const DEDUP_WINDOW_MS = 2000;

function hashRejection(sessionId, reason) {
  const data = { reason, session_id: sessionId };
  const dataStr = JSON.stringify(data, Object.keys(data).sort());
  return crypto.createHash('sha256').update(dataStr).digest('hex');
}

function alreadyCaptured(hash, nowMs) {
  try {
    const raw = fs.readFileSync(DEDUP_MARKER_PATH, 'utf8').trim();
    if (!raw) return false;
    // Support two forms for backward compat: a bare hex digest (old single-
    // hash format, written by the initial A2 land) and the new JSON form
    // {hash, ts}. Bare-hex falls through to "no suppress" because we can't
    // reason about its age.
    if (raw.startsWith('{')) {
      const prev = JSON.parse(raw);
      if (prev?.hash !== hash) return false;
      if (typeof prev?.ts !== 'number') return false;
      return (nowMs - prev.ts) < DEDUP_WINDOW_MS;
    }
    return false;
  } catch { return false; }
}

function markCaptured(hash, nowMs) {
  try {
    fs.writeFileSync(DEDUP_MARKER_PATH, JSON.stringify({ hash, ts: nowMs }), 'utf8');
  } catch {}
}

// 2026-05-31: G1 fix. Original capture path (stdin candidates) never fired in
// production — the Stop hook payload Claude Code provides does not include the
// prior prompt-hook's JSON result. Result: 0 real Layer3a-rejection events ever
// persisted (verified 2026-05-31 — supervisory-log.md had 1 doc-line + 1
// synthetic-test from 2026-04-25; oversight-events.jsonl had 0 events).
//
// New behavior: try stdin first (fast path, may work in future versions); if
// rejection is null, fall back to reading the transcript JSONL referenced by
// input.transcript_path and extracting the most recent "Stop hook feedback:"
// user-role entry. ADDITIVE — existing path preserved.
//
// 2026-05-31 A2 refinement: original fallback used a fixed 1MB tail window,
// which truncates when the most recent Stop-hook-feedback entry sits past
// that boundary (large workflow outputs, embedded HTML payloads). Replaced
// with a chunked backwards reader that walks the file in 256 KB pages from
// end toward start until either the rejection is found or a 10 MB cap is
// hit. Partial JSON lines at the leading edge of each chunk are deferred
// until the next iteration brings their head into view.
function findStopHookFeedback(transcriptPath) {
  try {
    const stat = fs.statSync(transcriptPath);
    if (stat.size === 0) return null;

    const CHUNK_SIZE = 256 * 1024;
    const MAX_READ_BYTES = 10 * 1024 * 1024;

    const fd = fs.openSync(transcriptPath, 'r');
    try {
      let position = stat.size;
      let buffered = '';
      let bytesRead = 0;

      while (position > 0 && bytesRead < MAX_READ_BYTES) {
        const readSize = Math.min(CHUNK_SIZE, position);
        position -= readSize;
        const buf = Buffer.alloc(readSize);
        fs.readSync(fd, buf, 0, readSize, position);
        bytesRead += readSize;
        buffered = buf.toString('utf8') + buffered;

        const lines = buffered.split('\n');
        // When position > 0 the first split element is a partial line whose
        // head lives in an earlier chunk we haven't read yet. Skip it; the
        // next iteration completes it.
        const startIdx = position > 0 ? 1 : 0;
        for (let i = lines.length - 1; i >= startIdx; i--) {
          const line = lines[i];
          if (!line) continue;
          let entry;
          try { entry = JSON.parse(line); } catch { continue; }
          if (entry?.type !== 'user') continue;
          const content = entry?.message?.content;
          if (typeof content !== 'string') continue;
          if (!content.startsWith('Stop hook feedback:')) continue;
          return content;
        }
      }
    } finally {
      try { fs.closeSync(fd); } catch {}
    }
  } catch {}
  return null;
}

function tryTranscriptFallback(input) {
  const transcriptPath = input?.transcript_path;
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  const content = findStopHookFeedback(transcriptPath);
  if (!content) return null;
  // Format: "Stop hook feedback:\n[prompt body...]: <reason>"
  // Extract reason after the LAST "]:" — the prompt body itself contains
  // "]" but ends with "]:" before the actual rejection text.
  const sep = content.lastIndexOf(']:');
  if (sep === -1) return null;
  const reason = content.slice(sep + 2).trim();
  if (!reason) return null;
  // Heuristic: real rejections start with "Rule N" or "[Rule N]" or "loop-break".
  // Approvals say "{\"ok\": true}" and short-circuit elsewhere.
  if (!/^(\[?Rule\s+\d|loop-break)/i.test(reason)) return null;
  return { ok: false, reason, source: 'transcript_fallback' };
}

wrapHook('layer3a-capture', (input) => {
  const candidates = [
    input,
    input?.prompt_result,
    input?.result,
    input?.previous_result,
    input?.last_hook_result,
  ].filter(Boolean);

  let rejection = null;
  for (const c of candidates) {
    if (typeof c?.ok === 'boolean' && c.ok === false && typeof c?.reason === 'string') {
      rejection = c;
      break;
    }
  }

  // G1 fix: transcript fallback when stdin path yields nothing.
  if (!rejection) rejection = tryTranscriptFallback(input);

  if (!rejection) return {};

  const sessionId = input?.session_id || '';
  const dedupHash = hashRejection(sessionId, rejection.reason);
  const nowMs = Date.now();
  if (alreadyCaptured(dedupHash, nowMs)) return {};

  const sessionShort = sessionId.slice(0, 8);
  const ts = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  // CRITICAL size bound (Phase 1 C3, 2026-05-02): the .slice(0, 400) on
  // reasonShort keeps the appended entry < 500 chars total. DO NOT remove
  // this slice — see atomicity assumption below.
  const reasonShort = rejection.reason.replace(/\s+/g, ' ').slice(0, 400);
  const entry = `\n- **${ts}** | \`${sessionShort}\` | Layer3a-rejection | ${reasonShort}\n`;

  // JSONL atomic-append assumption: unlocked because Windows NTFS guarantees
  // atomicity for sub-block writes (~4KB). Entry is bounded above by the
  // .slice(0, 400) on reasonShort. If reason content can grow unbounded,
  // tighten the slice OR switch to lib/file-lock.js withLock.
  try { fs.appendFileSync(OVERSIGHT_LOG_PATH, entry, 'utf8'); } catch {}

  appendOversightEvent('layer3a_rejection', {
    session_id: sessionId,
    reason: rejection.reason,
  });

  markCaptured(dedupHash, nowMs);

  return {};
}, { hookType: 'Stop' });

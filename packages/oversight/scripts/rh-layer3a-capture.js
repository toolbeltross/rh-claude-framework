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
const { appendOversightEvent } = require('./lib/oversight-events');
const { wrapHook } = require('./lib/hook-timing');
const { config } = require('./lib/config');

const OVERSIGHT_LOG_PATH = process.env.OVERSIGHT_LOG_PATH ||
  path.join(config.claudeDir, 'telemetry-supervisory-log.md');

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

  if (!rejection) return {};

  const sessionId = (input?.session_id || '').slice(0, 8);
  const ts = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  // CRITICAL size bound (Phase 1 C3, 2026-05-02): the .slice(0, 400) on
  // reasonShort keeps the appended entry < 500 chars total. DO NOT remove
  // this slice — see atomicity assumption below.
  const reasonShort = rejection.reason.replace(/\s+/g, ' ').slice(0, 400);
  const entry = `\n- **${ts}** | \`${sessionId}\` | Layer3a-rejection | ${reasonShort}\n`;

  // JSONL atomic-append assumption: unlocked because Windows NTFS guarantees
  // atomicity for sub-block writes (~4KB). Entry is bounded above by the
  // .slice(0, 400) on reasonShort. If reason content can grow unbounded,
  // tighten the slice OR switch to lib/file-lock.js withLock.
  try { fs.appendFileSync(OVERSIGHT_LOG_PATH, entry, 'utf8'); } catch {}

  appendOversightEvent('layer3a_rejection', {
    session_id: input?.session_id || '',
    reason: rejection.reason,
  });

  return {};
}, { hookType: 'Stop' });

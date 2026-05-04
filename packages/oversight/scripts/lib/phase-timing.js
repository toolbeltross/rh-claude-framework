// phase-timing.js — sub-script phase instrumentation helper.
//
// Phase 1 follow-on (2026-05-02): closes the gap noted in `OVERSIGHT_SYSTEM.md`
// "What's NOT tracked": per-line / per-statement traces inside scripts. Hooks
// (which use `lib/hook-timing.js wrapHook`) already get whole-fire wall-clock.
// Non-hook scripts and internal phases of hook scripts now have a similar
// pattern via this helper.
//
// USAGE (sync):
//   const { withPhase } = require('./lib/phase-timing');
//   const result = withPhase('learning-loop', 'build-groups',
//     () => buildGroups(events), { sessionId });
//
// USAGE (async):
//   const result = await withPhase('learning-loop', 'dispatch-supervisor',
//     async () => spawnSync(...), { sessionId });
//
// Records `{ts, script, phase, durationMs, sessionId, outcome}` to
// `~/.claude/phase-timing.jsonl` (separate from hook-perf.jsonl to keep the
// hook-level perf-audit untainted by internal-phase noise).
//
// Cost: <1ms per phase boundary on Windows NTFS. Phase records are bounded
// (no user content) so the JSONL atomic-append assumption holds (Phase 1 C3).

const fs = require('fs');
const path = require('path');

const HOME = process.env.HOME || process.env.USERPROFILE || '';
const PHASE_LOG = path.join(HOME, '.claude', 'phase-timing.jsonl');

function appendPhase(script, phase, t0, outcome, sessionId) {
  const durationMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const record = {
    ts: new Date().toISOString(),
    script,
    phase,
    durationMs: Math.round(durationMs * 10) / 10,
    sessionId: (sessionId || '').slice(0, 8),
    outcome,
  };
  // JSONL atomic-append assumption (Phase 1 C3, 2026-05-02): unlocked because
  // the record is fixed-shape (script + phase + durations + ids) — well under
  // the NTFS sub-block atomicity bound (~4KB). Multiple parallel scripts may
  // append to this file but record sizes stay bounded.
  try { fs.appendFileSync(PHASE_LOG, JSON.stringify(record) + '\n'); } catch {}
}

// Sync wrapper — `fn` runs synchronously, return value is propagated.
function withPhase(script, phase, fn, opts = {}) {
  const t0 = process.hrtime.bigint();
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      // Caller passed an async fn but used sync wrapper — chain the timing onto the promise.
      return result.then(
        v => { appendPhase(script, phase, t0, 'ok', opts.sessionId); return v; },
        e => { appendPhase(script, phase, t0, 'error', opts.sessionId); throw e; }
      );
    }
    appendPhase(script, phase, t0, 'ok', opts.sessionId);
    return result;
  } catch (e) {
    appendPhase(script, phase, t0, 'error', opts.sessionId);
    throw e;
  }
}

module.exports = { withPhase };

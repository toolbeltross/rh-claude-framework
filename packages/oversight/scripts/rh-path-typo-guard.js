// rh-path-typo-guard.js
// PreToolUse:Read hook — auto-corrects common model-side typos of `.claude/`
// to the real `.claude/` segment when the corrected path exists on disk.
//
// Motivation: telemetry showed Read failures where the model wrote
// `.claire/worktrees/...` or `.clone/worktrees/...` instead of `.claude/...`
// (model autocorrect / semantic confusion). These produced 50+ ENOENT
// failures across recent sessions. The corrected path is unambiguous — if
// the path with `.claude` substituted exists, it's almost certainly what
// the model meant.
//
// Safety: only Read is intercepted (not Write/Edit/Bash). If the corrected
// path does not exist, the original is passed through unchanged so the
// Read tool reports its normal ENOENT — never silently retargets a write
// to the wrong file.
//
// Telemetry: every auto-correct POSTs a `path_typo_corrected` event so the
// supervisor can see the rewrite. Original + corrected paths included.

const http = require('http');
const fs = require('fs');
const { appendOversightEvent } = require('./lib/oversight-events');
const { wrapHook } = require('./lib/hook-timing');
const { config } = require('./lib/config');

// Common model-side substitutions for `.claude` observed in telemetry-failures.
// Match as path segment (preceded by separator, followed by separator) so
// `.clone` directories that are legitimately named (e.g., git clones) are
// only rewritten when followed by typical `.claude/` children.
const TYPO_PATTERNS = [
  /([\\/])\.claire([\\/])/g,
  /([\\/])\.clone([\\/])/g,
  /([\\/])\.clauds([\\/])/g,
  /([\\/])\.cluade([\\/])/g,
  /([\\/])\.claure([\\/])/g,
  /([\\/])\.cluades([\\/])/g,
];

function correctPath(p) {
  let out = p;
  let changed = false;
  for (const re of TYPO_PATTERNS) {
    if (re.test(out)) {
      out = out.replace(re, '$1.claude$2');
      changed = true;
    }
  }
  return changed ? out : null;
}

function notifyTelemetry(eventType, error, extra) {
  if (process.env.OVERSIGHT_SELF_TEST === '1') return;
  try {
    const body = JSON.stringify({
      tool_name: 'Read',
      event_type: eventType,
      success: true,
      error,
      session_id: '',
      ...(extra || {}),
    });
    const req = http.request(
      `http://localhost:${config.telemetryPort}/api/hooks`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 1200 },
      (res) => { res.resume(); }
    );
    req.on('error', () => {});
    req.on('timeout', () => { req.destroy(); });
    req.write(body);
    req.end();
  } catch {}
}

wrapHook('path-typo-guard', (input) => {
  const toolInput = input?.tool_input || {};
  const filePath = toolInput.file_path || '';
  const sessionId = input?.session_id || '';

  if (!filePath) return {};

  const corrected = correctPath(filePath);
  if (!corrected) return {};

  // Only rewrite if the corrected path actually exists. If neither original
  // nor corrected exists, pass through so the Read tool reports the normal
  // ENOENT (don't silently retarget when intent is ambiguous).
  let correctedExists = false;
  try { correctedExists = fs.existsSync(corrected); } catch {}
  if (!correctedExists) return {};

  const updatedInput = { ...toolInput, file_path: corrected };

  process.stderr.write(`[path-typo-guard] Rewrote Read path: ${filePath} -> ${corrected}\n`);

  notifyTelemetry('path_typo_corrected',
    `[AUTO-CORRECT] Read path typo: ${filePath} -> ${corrected}`,
    {
      session_id: sessionId,
      tool_input: { file_path: corrected, original_path: filePath },
    }
  );

  appendOversightEvent('path_typo_corrected', {
    session_id: sessionId,
    original_path: filePath,
    corrected_path: corrected,
  });

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput,
    }
  };
}, { hookType: 'PreToolUse', matcher: 'Read' });

// consolidation-guard.js
// PreToolUse:Write hook — blocks consolidation-document Writes that lack a
// Source Registry with verification tokens.
//
// Refactor 2026-04-25 (proposed + accepted): the previous version had two
// silent-failure problems (a) JSON.parse on malformed stdin would throw,
// causing fail-CLOSED behavior (block); (b) blocks were not surfaced to the
// telemetry feed, so the supervisor was blind. Fixes:
//   - Try/catch around stdin parse with fail-OPEN on malformed input
//   - Fire-and-forget POST to /api/hooks on every block so the supervisor sees them

const http = require('http');
const { appendOversightEvent } = require('./lib/oversight-events');
const { wrapHook } = require('./lib/hook-timing');
const { config } = require('./lib/config');

function notifyTelemetry(eventType, error, extra) {
  if (process.env.OVERSIGHT_SELF_TEST === '1') return;
  try {
    const body = JSON.stringify({
      tool_name: 'Write',
      event_type: eventType,
      success: false,
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

wrapHook('consolidation-guard', (input) => {
  const filename = input?.tool_input?.file_path || '';
  const content  = input?.tool_input?.content   || '';
  const sessionId = input?.session_id || '';

  const isConsolidation = /MASTER_|CONSOLIDATED|_master\./i.test(filename);
  const hasRegistry     = /Source Registry/i.test(content);
  const hasTokens       = /verification token|last line/i.test(content);

  if (isConsolidation && (!hasRegistry || !hasTokens)) {
    const reason =
      'Consolidation document rejected: missing Source Registry with verification tokens.\n' +
      'Add a "Source Registry" section listing each source file\'s last line verbatim\n' +
      'plus total line count and which lines were read before this file will be written.';

    notifyTelemetry('consolidation_blocked',
      `[BLOCK] Missing Source Registry / tokens for ${filename}`,
      {
        session_id: sessionId,
        tool_input: { file_path: filename, missing_registry: !hasRegistry, missing_tokens: !hasTokens },
      }
    );

    appendOversightEvent('consolidation_blocked', {
      session_id: sessionId,
      file_path: filename,
      missing_registry: !hasRegistry,
      missing_tokens: !hasTokens,
    });

    return { decision: 'block', reason };
  }

  return { decision: 'allow' };
}, { hookType: 'PreToolUse', matcher: 'Write', failOpenResult: { decision: 'allow' } });

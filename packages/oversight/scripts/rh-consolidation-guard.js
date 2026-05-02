// consolidation-guard.js
// PreToolUse:Write hook — blocks consolidation-document Writes that lack a
// Source Registry with verification tokens.

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
      `${config.telemetryUrl}/api/hooks`,
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
  const hasTokens       = /verification token|first line/i.test(content);

  if (isConsolidation && (!hasRegistry || !hasTokens)) {
    const reason =
      'Consolidation document rejected: missing Source Registry with verification tokens.\n' +
      'Add a "Source Registry" section listing each source file\'s first line verbatim\n' +
      'and which lines were read before this file will be written.';

    notifyTelemetry('consolidation_blocked',
      `[BLOCK] Missing Source Registry / tokens for ${filename}`,
      { session_id: sessionId, tool_input: { file_path: filename, missing_registry: !hasRegistry, missing_tokens: !hasTokens } }
    );

    appendOversightEvent('consolidation_blocked', {
      session_id: sessionId, file_path: filename, missing_registry: !hasRegistry, missing_tokens: !hasTokens,
    });

    return { decision: 'block', reason };
  }

  return { decision: 'allow' };
}, { hookType: 'PreToolUse', matcher: 'Write', failOpenResult: { decision: 'allow' } });

// layer3a-capture.js
// Stop hook — captures Layer 3a rejection reasons to supervisory-log.

const fs = require('fs');
const path = require('path');
const { appendOversightEvent } = require('./lib/oversight-events');
const { wrapHook } = require('./lib/hook-timing');
const { config } = require('./lib/config');

wrapHook('layer3a-capture', (input) => {
  const candidates = [
    input, input?.prompt_result, input?.result, input?.previous_result, input?.last_hook_result,
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
  const reasonShort = rejection.reason.replace(/\s+/g, ' ').slice(0, 400);
  const entry = `\n- **${ts}** | \`${sessionId}\` | Layer3a-rejection | ${reasonShort}\n`;

  try { fs.appendFileSync(config.oversightLogPath, entry, 'utf8'); } catch {}

  appendOversightEvent('layer3a_rejection', {
    session_id: input?.session_id || '',
    reason: rejection.reason,
  });

  return {};
}, { hookType: 'Stop' });

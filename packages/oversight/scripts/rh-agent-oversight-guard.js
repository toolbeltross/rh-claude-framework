// agent-oversight-guard.js
// PreToolUse:Agent hook — enforces subagent-oversight.md by AUTO-APPENDING the
// canonical oversight block to any Agent dispatch prompt that doesn't already
// contain the three required elements (verification tokens, context report,
// batch overflow rule).
//
// Behavior:
//   - All 3 elements present → allow, no mutation
//   - Any element missing    → auto-append canonical block, allow with updatedInput
//
// Telemetry: every auto-append POSTs an `oversight_auto_inject` event to the
// telemetry server (fire-and-forget) so the supervisor can see how often
// prompts get mutated and why. The supervisor was previously blind to this
// because the auto-append was logged only to stderr / hook-debug.log.

const http = require('http');
const { appendOversightEvent } = require('./lib/oversight-events');
const { wrapHook } = require('./lib/hook-timing');
const { config } = require('./lib/config');

function notifyTelemetry(eventType, error, extra) {
  if (process.env.OVERSIGHT_SELF_TEST === '1') return;
  try {
    const body = JSON.stringify({
      tool_name: 'Agent',
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

const CANONICAL_BLOCK = `

---

## Required oversight block (auto-injected by agent-oversight-guard)

1. **Verification tokens**: For each item processed, return a provable artifact that demonstrates completeness — for files: the literal **last line** of the file plus total line count and the line range actually read (e.g., "lines 1–639 of 639"); for non-file sources (URLs, records, API responses): a unique identifying string copied verbatim from a section near the end of the source. Do not paraphrase.

2. **Self-reported telemetry**: End your response with:
   - Items found / successfully processed / failed or truncated (list any failures by name)
   - Context usage: **#compactions** and **% of context window used**
   - If **> 85% used**: STOP immediately — do not process further items. Return results so far and remaining count. This is a failure condition, not a warning.

3. **Batch overflow rule**: If after processing the first item you can tell the full task will exceed your capacity, STOP and return only the first item's result plus the total count of remaining items. Do not attempt the full set.

4. **Count cross-reference**: Report the total number of items found at the source so the parent can verify against an independent count. If counts disagree, the result is suspect.`;

wrapHook('agent-oversight-guard', (input) => {
  const toolInput = input?.tool_input || {};
  const prompt = toolInput.prompt || '';
  const sessionId = input?.session_id || '';

  const checks = {
    verificationToken: /verification token|literal last line|last line verbatim/i.test(prompt),
    contextReport:     /compaction/i.test(prompt) && /% used/i.test(prompt),
    batchOverflow:     /batch overflow|STOP and return|stop.*remaining count/i.test(prompt),
  };

  const allPresent = Object.values(checks).every(Boolean);

  if (allPresent) return {};

  const updatedInput = { ...toolInput, prompt: prompt + CANONICAL_BLOCK };
  const missing = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([k]) => k);

  process.stderr.write(`[agent-oversight-guard] Auto-appended oversight block. Missing elements: ${missing.join(', ')}\n`);

  notifyTelemetry('oversight_auto_inject',
    `[AUTO-INJECT] Missing oversight elements appended: ${missing.join(', ')}`,
    {
      session_id: sessionId,
      tool_input: { description: toolInput.description || '', subagent_type: toolInput.subagent_type || '' },
      missing_elements: missing,
    }
  );

  appendOversightEvent('oversight_auto_inject', {
    session_id: sessionId,
    description: toolInput.description || '',
    subagent_type: toolInput.subagent_type || '',
    missing_elements: missing,
  });

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput,
    }
  };
}, { hookType: 'PreToolUse', matcher: 'Agent' });

/**
 * agent-result-guard.js — PostToolUse hook for Agent
 *
 * Scans subagent results for tool-failure signals (WebSearch denied,
 * WebFetch blocked, permission errors, zero-source research, etc.)
 * and emits a warning so the parent agent cannot silently degrade.
 *
 * Hook type: PostToolUse (matcher: Agent)
 * Input:  JSON on stdin with tool_input and tool_output
 * Output: JSON on stdout with { decision: "allow"|"block", reason? }
 *
 * This hook WARNS (does not block) — the Agent call already completed.
 * The "block" decision in PostToolUse surfaces the reason as a
 * system-reminder to the parent agent, forcing it to acknowledge
 * and address the failure rather than silently proceeding.
 *
 * 2026-04-25: also fires fire-and-forget POST to /api/hooks on detected
 * patterns so the supervisor sees subagent-failure-detection events
 * (was previously surfaced only as a system-reminder, never persisted).
 */

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

wrapHook('agent-result-guard', (input) => {
  const output = (input?.tool_output || input?.tool_result || '').toString();
  const desc   = input?.tool_input?.description || 'unnamed agent';
  const sessionId = input?.session_id || '';

  if (!output || output.length < 20) return {};

  const failures = [];

  if (/WebSearch.*denied|WebSearch.*blocked|WebFetch.*denied|WebFetch.*blocked/i.test(output)) {
    failures.push('WebSearch or WebFetch was denied/blocked in subagent');
  }

  if (/permission.*denied|tool.*not.*allowed|not.*permitted|access.*denied/i.test(output)) {
    if (!/court.*permission|statutory.*permission|written.*permission/i.test(output)) {
      failures.push('Tool permission was denied in subagent');
    }
  }

  if (/sources?\s*(found|consulted)\s*[:=]\s*0\b/i.test(output)) {
    failures.push('Subagent found zero sources');
  }
  if (/successfully\s*processed\s*[:=]\s*0\b/i.test(output)) {
    failures.push('Subagent processed zero items successfully');
  }

  if (/cannot complete this research|unable to (complete|perform|execute)/i.test(output)) {
    failures.push('Subagent reported inability to complete the task');
  }

  const failedMatch = output.match(/failed\s*(?:or\s*truncated)?\s*[:=]\s*(\d+)/i);
  const processedMatch = output.match(/successfully\s*processed\s*[:=]\s*(\d+)/i);
  if (failedMatch && processedMatch) {
    const failed    = parseInt(failedMatch[1], 10);
    const processed = parseInt(processedMatch[1], 10);
    if (failed > 0 && failed >= processed) {
      failures.push(`Subagent failure count (${failed}) >= success count (${processed})`);
    }
  }

  if (/> 85%.*STOP|context.*overflow|compaction.*occurred.*mid/i.test(output)) {
    failures.push('Subagent hit context limits — results may be incomplete');
  }

  // Protocol-compliance check (added 2026-05-04, F-09 follow-up):
  // If the dispatching prompt required the oversight protocol (either the author
  // included it, or rh-agent-oversight-guard.js auto-injected the canonical block),
  // the response should contain the self-reported telemetry block. Log violations
  // to oversight-events.jsonl as a soft signal — does NOT add to `failures` so
  // working flows are not disrupted on first deploy. Promote to hard block once
  // the false-positive rate is understood.
  const promptText = (input?.tool_input?.prompt || '').toString();
  const promptRequiredProtocol =
    /verification token|literal last line|last line verbatim/i.test(promptText) &&
    /compaction/i.test(promptText) &&
    /% used/i.test(promptText);

  if (promptRequiredProtocol && output.length > 200) {
    const hasTelemetryBlock =
      /items?\s*(found|processed|successful|failed)/i.test(output) &&
      (/context\s*usage|%\s*used|compaction/i.test(output));
    const hasVerificationArtifact =
      /last line[:\s]|verification token|line count[:\s]|lines? read/i.test(output);

    const protocolMissing = [];
    if (!hasTelemetryBlock) protocolMissing.push('telemetry-block');
    if (!hasVerificationArtifact) protocolMissing.push('verification-artifact');

    if (protocolMissing.length > 0) {
      notifyTelemetry('subagent_protocol_violation',
        `[PROTOCOL VIOLATION] ${desc}: missing ${protocolMissing.join(', ')}`,
        {
          session_id: sessionId,
          tool_input: { description: desc },
          missing_elements: protocolMissing,
        }
      );
      appendOversightEvent('subagent_protocol_violation', {
        session_id: sessionId,
        description: desc,
        missing_elements: protocolMissing,
      });
      process.stderr.write(`[agent-result-guard] Protocol violation in "${desc}": missing ${protocolMissing.join(', ')}\n`);
    }
  }

  if (failures.length > 0) {
    const reason =
      `SUBAGENT FAILURE DETECTED in "${desc}":\n` +
      failures.map(f => `  - ${f}`).join('\n') + '\n\n' +
      'ACTION REQUIRED: Do NOT silently proceed with degraded results.\n' +
      'Inform the user immediately and ask for help resolving the issue\n' +
      '(e.g., permission approval, re-run in foreground, alternative approach).\n' +
      'Do NOT substitute training knowledge without explicit user consent.';

    notifyTelemetry('subagent_failure_detected',
      `[SUBAGENT FAILURE] ${desc}: ${failures.join('; ')}`,
      {
        session_id: sessionId,
        tool_input: { description: desc },
        patterns: failures,
      }
    );

    appendOversightEvent('subagent_failure_detected', {
      session_id: sessionId,
      description: desc,
      patterns: failures,
    });

    return {
      decision: 'block',
      reason,
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: reason
      }
    };
  }

  return {};
}, { hookType: 'PostToolUse', matcher: 'Agent' });

// hook-timing.js — shared timing wrapper for oversight hooks.
// Records wall-clock execution time to hook-perf.jsonl and POST /api/hook-perf.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { config } = require('./config');

function extractOutcome(result) {
  if (result.decision) return result.decision;
  const hso = result.hookSpecificOutput;
  if (hso?.updatedInput) return 'inject';
  if (hso?.additionalContext) return 'warn';
  if (hso?.permissionDecision) return hso.permissionDecision;
  return 'noop';
}

function appendPerf(hookName, t0, outcome, options, sessionId) {
  const durationMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const record = {
    ts: new Date().toISOString(),
    hook: hookName,
    durationMs: Math.round(durationMs * 10) / 10,
    sessionId: (sessionId || '').slice(0, 8),
    outcome,
    hookType: options.hookType || '',
    matcher: options.matcher || '',
  };

  try { fs.appendFileSync(config.perfLogPath, JSON.stringify(record) + '\n'); } catch {}

  if (process.env.OVERSIGHT_SELF_TEST === '1') return;
  try {
    const body = JSON.stringify(record);
    const req = http.request(
      `${config.telemetryUrl}/api/hook-perf`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 1200 },
      (res) => { res.resume(); }
    );
    req.on('error', () => {});
    req.on('timeout', () => { req.destroy(); });
    req.write(body);
    req.end();
  } catch {}
}

function wrapHook(hookName, mainFn, options = {}) {
  const t0 = process.hrtime.bigint();
  const failOpen = options.failOpenResult || {};

  process.stdin.setEncoding('utf8');
  let data = '';
  process.stdin.on('data', chunk => { data += chunk; });
  process.stdin.on('end', () => {
    let input;
    try { input = JSON.parse(data); } catch {
      process.stdout.write(JSON.stringify(failOpen));
      appendPerf(hookName, t0, 'parse_error', options, '');
      return;
    }

    const sessionId = input?.session_id || '';
    let result;
    try {
      result = mainFn(input);
    } catch {
      process.stdout.write(JSON.stringify(failOpen));
      appendPerf(hookName, t0, 'error', options, sessionId);
      return;
    }

    process.stdout.write(JSON.stringify(result));
    appendPerf(hookName, t0, extractOutcome(result), options, sessionId);
  });
}

module.exports = { wrapHook };

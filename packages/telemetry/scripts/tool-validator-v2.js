#!/usr/bin/env node
/**
 * Tool Validator v2 — Environment-aware PreToolUse:Bash hook.
 *
 * Three response tiers:
 *   ALLOW  — exit 0, no stdout (command is fine)
 *   SUGGEST — exit 0, JSON stdout with contextAddition (nudge Claude toward better tool)
 *   BLOCK  — exit 2, stderr (genuinely dangerous command)
 *
 * Uses contextAddition instead of blocking for wrong-tool patterns,
 * which avoids cascade cancellation of parallel tool calls.
 */

import http from 'http';
import { detectEnv, ALLOWLIST, DANGEROUS_PATTERNS, getToolSuggestion } from './env-rules.js';

const TELEMETRY_PORT = parseInt(process.env.RH_TELEMETRY_PORT || process.env.PORT, 10) || 7890;

/** Fire-and-forget POST to telemetry server. Never blocks, never throws. */
function notifyServer(toolName, eventType, reason, sessionId, agentId) {
  try {
    const body = JSON.stringify({
      tool_name: toolName,
      event_type: eventType,
      success: false,
      error: reason,
      session_id: sessionId || '',
      agent_id: agentId || '',
    });
    const req = http.request(
      `http://localhost:${TELEMETRY_PORT}/api/hooks`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 1200 },
      (res) => { res.resume(); }
    );
    req.on('error', () => {});
    req.on('timeout', () => { req.destroy(); });
    req.write(body);
    req.end();
  } catch {}
}

// ─── Read stdin ──────────────────────────────────────────────────────────────

let data = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => { data += chunk; });
process.stdin.on('end', () => {
  let command = '';
  let stdinData = {};
  try {
    stdinData = JSON.parse(data);
    command = stdinData.tool_input?.command || '';
  } catch {
    // Can't parse — allow through
    process.exit(0);
  }

  if (!command) {
    process.exit(0);
  }

  const cmd = command.trim();
  const env = detectEnv(stdinData);

  // ── Step 1: Check for genuinely dangerous commands (BLOCK) ──

  const sessionId = stdinData.session_id || '';
  // C3 — agent_id is passed by Claude Code when the Bash call originates inside
  // a subagent. If present, the validation event will be attributed to that agent
  // so per-agent validation-block tallies are accurate.
  const agentId = stdinData.agent_id || '';

  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(cmd)) {
      const reason = pattern.message || 'Dangerous command blocked';
      notifyServer('Bash', 'validation_block', `[BLOCK] ${reason}`, sessionId, agentId);
      process.stderr.write(`[tool-validator-v2] ${reason}\n`);
      process.exit(2);
    }
  }

  // ── Step 2: Extract base command name ──

  // Handle pipes: check first command in pipeline
  const firstCmd = cmd.split(/[|;]/)
    .map(s => s.trim())
    .filter(Boolean)[0] || '';

  // Get base command name (strip path, handle env vars like VAR=val cmd)
  let baseParts = firstCmd.split(/\s+/);
  // Skip env var assignments (KEY=VAL ...)
  while (baseParts.length > 0 && baseParts[0].includes('=') && !baseParts[0].startsWith('-')) {
    baseParts.shift();
  }
  const baseCmd = baseParts[0] || '';
  const cmdName = baseCmd.replace(/^.*[\\/]/, ''); // strip path

  // ── Step 3: Check for wrong-tool suggestions FIRST ──
  // Must run before allowlist because some allowlisted commands (echo, cat, grep, find, sed, awk)
  // have suggestions when used in certain ways (e.g., echo > file → Write tool)

  const suggestion = getToolSuggestion(cmdName, cmd, env);
  if (suggestion) {
    notifyServer('Bash', 'validation_suggest', `[SUGGEST] ${suggestion}`, sessionId, agentId);
    // Output JSON to stdout — contextAddition shown to Claude without blocking
    const output = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        contextAddition: `[tool-validator] ${suggestion}`,
      },
    };
    process.stdout.write(JSON.stringify(output));
    process.exit(0); // Exit 0 = no cascade cancellation
  }

  // ── Step 4: Allowlist check ──

  if (ALLOWLIST.has(cmdName) || ALLOWLIST.has(cmdName.toLowerCase())) {
    process.exit(0);
  }

  // Also allow powershell.exe / pwsh.exe / cmd.exe wrappers
  if (/^(powershell|pwsh|cmd)(\.exe)?$/i.test(cmdName)) {
    process.exit(0);
  }

  // Allow quoted paths (e.g., "/c/Program Files/nodejs/node.exe")
  if (baseCmd.startsWith('"') || baseCmd.startsWith("'") || baseCmd.includes('/')) {
    // Likely a path to an executable — extract final filename
    const execName = baseCmd.replace(/['"]/g, '').replace(/^.*[\\/]/, '').replace(/\.exe$/i, '');
    if (ALLOWLIST.has(execName) || ALLOWLIST.has(execName.toLowerCase())) {
      process.exit(0);
    }
  }

  // ── Step 5: Unknown command — allow through ──
  process.exit(0);
});

// Timeout safety (4s, well under the 5s hook timeout)
setTimeout(() => process.exit(0), 4000);
#!/usr/bin/env node
// rh-daily-guidance.js — daily guidance + health digest, as a daily-regen STEP.
//
// Piggy-backs on the existing first-session-of-day pipeline (rh-daily-regen.js);
// no separate scheduler/hook. Steward-conditioned design (2026-06-15):
//  - The LLM gets NO Bash (C1): this driver PRE-COMPUTES the local tool outputs
//    (health / self-test / scribe / watched-doc drift) in Node and injects them
//    as text. The headless run only needs WebFetch/WebSearch/Read/Write/Glob.
//  - Authority lives in the version-controlled agent rh-daily-guidance.md (C2),
//    not in a user-editable cowork/ file. We dispatch `--agent rh-daily-guidance`.
//
// The agent acquires external guidance (web), combines it with the injected
// local context, and Writes cowork/daily-digest-<date>.md (+ draft proposals).
// Idempotent: SKIPs if today's digest exists. Fail-tolerant: never throws.
//
// Usage: rh-daily-guidance.js [--dry-run]
// Output: single-line JSON (honors the daily-regen SKIP contract).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { config } = require('./lib/config');

let appendOversightEvent = () => {};
try { ({ appendOversightEvent } = require('./lib/oversight-events')); } catch { /* optional */ }

const DRY_RUN = process.argv.includes('--dry-run');
const COWORK = path.join(config.workspace, 'cowork');
const SCRIPTS = path.join(config.claudeDir, 'scripts');
const GUIDANCE_MD = path.join(config.oversightDir, '..', 'environment', 'GUIDANCE_CHANGES.md');
const DISPATCH_TIMEOUT_MS = 8 * 60 * 1000;
// Bash intentionally ABSENT (steward C1). Write is bounded to cowork/ by the agent.
const ALLOWED_TOOLS = ['WebFetch', 'WebSearch', 'Read', 'Write', 'Glob', 'Grep'];

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const digestPath = (day) => path.join(COWORK, `daily-digest-${day}.md`);

function nodeOut(script, args = [], timeout = 60000) {
  // Return raw stdout only. Several of these scripts exit non-zero by design
  // (rh-oversight-health exits 1/2 for DEGRADED/CRITICAL) while still emitting
  // valid JSON on stdout — so do NOT append an exit marker (it would corrupt
  // a JSON parse downstream).
  try {
    const r = spawnSync('node', [path.join(SCRIPTS, script), ...args], { encoding: 'utf8', timeout, windowsHide: true });
    return (r.stdout || '').trim();
  } catch { return ''; }
}

// Pre-compute the local context the agent must NOT recompute (it has no Bash).
function localContext() {
  const parts = [];

  // Health (one-line verdict + any non-ok probe lines).
  let health = '(unavailable)';
  try {
    const j = JSON.parse(nodeOut('rh-oversight-health.js', ['--json']) || '{}');
    const flagged = (j.probes || []).filter(p => p.level === 'warn' || p.level === 'crit')
      .map(p => `${p.name}: ${p.detail}`);
    health = `exit ${j.exitCode} (${j.exitCode === 0 ? 'HEALTHY' : j.exitCode === 1 ? 'DEGRADED' : 'CRITICAL'})` +
      (flagged.length ? `\nflagged: ${flagged.join(' | ')}` : '');
  } catch { /* leave unavailable */ }
  parts.push('### Health\n' + health);

  // Self-test (last N/N line).
  const st = nodeOut('rh-oversight-self-test.js');
  const stLine = (st.match(/oversight-self-test: .*$/m) || ['(no result line)'])[0];
  parts.push('### Self-test\n' + stLine);

  // Scribe backlog (counts).
  let scribe = '(unavailable)';
  try {
    const j = JSON.parse(nodeOut('rh-scribe-query.js') || '{}');
    const c = j.counts || {};
    scribe = `${c.open_total || 0} open (${Object.entries(c.by_bucket || {}).map(([k, v]) => k + ' ' + v).join(', ')}); ` +
      `${c.proposed || 0} with a proposed disposition awaiting review at http://localhost:7890/scribe`;
  } catch { /* leave unavailable */ }
  parts.push('### Scribe backlog\n' + scribe);

  // Watched-doc guidance drift (from GUIDANCE_CHANGES.md).
  let drift = 'no GUIDANCE_CHANGES.md (no recent watched-doc drift)';
  try {
    if (fs.existsSync(GUIDANCE_MD)) {
      const txt = fs.readFileSync(GUIDANCE_MD, 'utf8');
      const m = txt.match(/Changed since last run:[^\d]*(\d+)\s+of\s+(\d+)\s+pages/i);
      drift = m ? `${m[1]} of ${m[2]} watched Anthropic docs changed (see GUIDANCE_CHANGES.md in the environment docs)` : 'GUIDANCE_CHANGES.md present; no parseable change count';
    }
  } catch { /* leave default */ }
  parts.push('### Watched-doc drift\n' + drift);

  return parts.join('\n\n');
}

function main() {
  const day = today();

  if (fs.existsSync(digestPath(day))) {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: 'digest-exists', day }));
    return;
  }

  const ctx = localContext();
  const kickoff = [
    `today=${day}`,
    `COWORK_DIR=${COWORK}`,
    '',
    'LOCAL CONTEXT (pre-computed — use verbatim, do not recompute):',
    ctx,
    '',
    'Now run today\'s daily guidance digest per your agent instructions: read <COWORK_DIR>/sources.json,',
    'acquire external guidance from the non-watched sources, and Write the digest (+ any proposals)',
    `to <COWORK_DIR>/. The required output is <COWORK_DIR>/daily-digest-${day}.md.`,
  ].join('\n');

  if (DRY_RUN) {
    console.log(JSON.stringify({ ok: true, dryRun: true, day, kickoff_chars: kickoff.length,
      will_write: digestPath(day), agent: 'rh-daily-guidance', allowed_tools: ALLOWED_TOOLS,
      local_context_preview: ctx.slice(0, 600) }));
    return;
  }

  const r = spawnSync('claude', ['-p', '--agent', 'rh-daily-guidance', '--allowedTools', ...ALLOWED_TOOLS], {
    encoding: 'utf8', timeout: DISPATCH_TIMEOUT_MS, cwd: config.workspace,
    input: kickoff, windowsHide: true,
  });

  const wrote = fs.existsSync(digestPath(day));
  const ok = !r.error && r.status === 0 && wrote;
  const reason = r.error ? String(r.error.message || r.error)
    : r.status !== 0 ? 'claude exit ' + r.status
    : !wrote ? 'no digest written' : undefined;

  appendOversightEvent('daily_guidance_run', { ok, day, digest_written: wrote, reason, stderr_tail: (r.stderr || '').slice(-300) });
  console.log(JSON.stringify({ ok, day, digest_written: wrote, reason }));
}

if (require.main === module) {
  try { main(); }
  catch (e) { console.log(JSON.stringify({ ok: false, reason: 'fatal', error: String(e.message || e) })); }
}
module.exports = { localContext };

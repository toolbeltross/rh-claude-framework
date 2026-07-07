#!/usr/bin/env node
// rh-scribe-triage.js — daily propose-only triage of the open scribe backlog.
//
// PLAN-2026-06-15-scribe-disposition-ui (closes F-K). Runs as a daily-regen
// step (after rh-auto-prune). Reads OPEN rows from the canonical md files
// (md is authoritative; the Postgres shadow lags), dispatches rh-supervisor
// (scope=scribe-triage) headlessly for a per-row disposition proposal, and
// writes ONLY the proposed_* columns to scribe_rows. It NEVER flips a row's
// status — the user applies dispositions through the /scribe UI (propose-only
// invariant, mirrors rh-learning-loop.js).
//
// Dispatch pattern + same-day guard mirror rh-learning-loop.js. Cost: Sonnet
// on <=BATCH_CAP rows/day; dedup (proposed_at) advances through the backlog.
//
// Usage: rh-scribe-triage.js [--dry-run] [--limit N]
// Output: single-line JSON summary (daily-regen SKIP contract honored).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { config } = require('./lib/config');
const scribeMd = require('./lib/scribe-md');
const scribeDb = require('./lib/scribe-db');

let appendOversightEvent = () => {};
try { ({ appendOversightEvent } = require('./lib/oversight-events')); } catch { /* optional */ }

const DRY_RUN = process.argv.includes('--dry-run');
const limitArg = (() => { const i = process.argv.indexOf('--limit'); return i >= 0 ? parseInt(process.argv[i + 1], 10) : NaN; })();
const BATCH_CAP = Number.isInteger(limitArg) && limitArg > 0 ? limitArg : 40;
const SAME_DAY_GUARD_HOURS = 20;
const LAST_RUN_FILE = path.join(config.claudeDir, 'scribe-triage-last-run.txt');
const DISPATCH_TIMEOUT_MS = 5 * 60 * 1000;

function norm(p) { return String(p).replace(/\\/g, '/'); }

// Canonical scribe files to triage: cleanup + recommendations at the workspace
// root and the oversight-system project copy. (Learnings are low-fidelity
// per-turn snippets, not closeable backlog — excluded.) Matches the
// rh-scribe-row-update.js allowlist domain.
function scribeFiles() {
  const ws = norm(config.workspace);
  const ovr = norm(config.oversightDir);
  return [
    { file: ws + '/cleanup.md', bucket: 'cleanup' },
    { file: ws + '/recommendations.md', bucket: 'recommendations' },
    { file: ovr + '/cleanup.md', bucket: 'cleanup' },
    { file: ovr + '/recommendations.md', bucket: 'recommendations' },
  ];
}

function checkSameDayGuard() {
  try {
    const ageH = (Date.now() - fs.statSync(LAST_RUN_FILE).mtimeMs) / 3600000;
    if (ageH < SAME_DAY_GUARD_HOURS) return { skip: true, ageHours: ageH.toFixed(1) };
  } catch { /* no marker yet */ }
  return { skip: false };
}
function recordRun() { try { fs.writeFileSync(LAST_RUN_FILE, new Date().toISOString() + '\n'); } catch {} }

// Rows already proposed (proposed_at set) in the DB shadow, keyed bucket|src|id.
function alreadyProposed() {
  const set = new Set();
  const res = scribeDb.readRows({});
  if (!res.ok || !res.rows) return set;
  for (const r of res.rows) {
    if (r.proposed_at) set.add(`${r.bucket}|${norm(r.source_file || '')}|${r.row_id}`);
  }
  return set;
}

function ageDays(ts) {
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return null;
  return Math.round((Date.now() - t) / 86400000);
}

function collectUntriaged() {
  const proposed = alreadyProposed();
  const out = [];
  for (const { file, bucket } of scribeFiles()) {
    const { ok, rows } = scribeMd.readRows(file);
    if (!ok) continue;
    for (const r of rows) {
      if (r.status !== 'open') continue;
      const key = `${bucket}|${norm(file)}|${r.id}`;
      if (proposed.has(key)) continue;
      out.push({ row_id: r.id, bucket, source_file: norm(file), ts: r.ts, session: r.session,
                 age_days: ageDays(r.ts), text: r.text });
    }
  }
  // oldest first
  out.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  return out;
}

function buildPrompt(rows, today) {
  const slim = rows.map(r => ({ row_id: r.row_id, bucket: r.bucket, source_file: r.source_file,
                                ts: r.ts, age_days: r.age_days, text: r.text }));
  return [
    'scope=scribe-triage',
    'today=' + today,
    'rows=' + JSON.stringify(slim),
    '',
    'Honor the Scribe Triage Mode contract in your agent definition. Return ONLY a JSON array of',
    'per-row proposals — one object per input row_id, no prose, no code fence.',
  ].join('\n');
}

// C1: tolerate non-zero exit / empty / non-JSON stdout. Extract the first
// JSON array found; return [] on anything unparseable.
function parseProposals(stdout) {
  if (!stdout) return [];
  const s = stdout.indexOf('['); const e = stdout.lastIndexOf(']');
  if (s < 0 || e < s) return [];
  try { const arr = JSON.parse(stdout.slice(s, e + 1)); return Array.isArray(arr) ? arr : []; }
  catch { return []; }
}

const VALID = /^(stale|still-open|resolve|duplicate-of:.+)$/;

function dispatch(prompt) {
  // cwd: config.home (NOT an OneDrive path) — see windows-spawn-enoent-cwd.md.
  const r = spawnSync('claude', ['-p', '--agent', 'rh-supervisor', prompt], {
    encoding: 'utf8', timeout: DISPATCH_TIMEOUT_MS, cwd: config.home,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error };
}

function main() {
  const today = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD local

  const guard = checkSameDayGuard();
  if (guard.skip && !DRY_RUN) {
    console.log(JSON.stringify({ ok: true, skipped: 'same-day-guard', last_run_age_hours: guard.ageHours }));
    return;
  }

  const rows = collectUntriaged();
  if (rows.length === 0) {
    if (!DRY_RUN) recordRun();
    console.log(JSON.stringify({ ok: true, skipped: true, reason: 'no-untriaged-rows', open_untriaged: 0 }));
    return;
  }
  const batch = rows.slice(0, BATCH_CAP);

  if (DRY_RUN) {
    console.log(JSON.stringify({ ok: true, dryRun: true, open_untriaged: rows.length,
      batch: batch.length, sample: batch.slice(0, 3).map(r => ({ row_id: r.row_id, bucket: r.bucket, age_days: r.age_days })) }));
    return;
  }

  const res = dispatch(buildPrompt(batch, today));
  const proposals = parseProposals(res.stdout);

  // C1: dispatch failed or produced nothing usable — log, emit, no throw.
  if (res.error || res.status !== 0 || proposals.length === 0) {
    recordRun();
    const reason = res.error ? String(res.error.message || res.error)
      : res.status !== 0 ? 'supervisor exit ' + res.status : 'no parseable proposals';
    appendOversightEvent('scribe_triage_run', { ok: false, reason, batch: batch.length, stderr_tail: res.stderr.slice(-300) });
    console.log(JSON.stringify({ ok: false, reason, batch: batch.length, proposals: 0 }));
    return;
  }

  // Persist proposals. Ensure each row exists in the shadow (writeRow upsert —
  // incrementally backfills md-only rows) THEN set proposed_* (never status).
  const byId = new Map(batch.map(r => [r.row_id, r]));
  let written = 0, skipped = 0;
  for (const p of proposals) {
    const row = byId.get(p && p.row_id);
    if (!row || !p.disposition || !VALID.test(String(p.disposition))) { skipped++; continue; }
    scribeDb.writeRow({ bucket: row.bucket, row_id: row.row_id,
      session_id: row.session ? String(row.session).slice(0, 8) : null,
      ts: row.ts, content: row.text, status: 'open', source_file: row.source_file,
      raw_line: `| ${row.row_id} | ${row.ts} | ${row.session} | ${row.text} | open |` });
    const r = scribeDb.setProposal({ bucket: row.bucket, source_file: row.source_file, row_id: row.row_id,
      disposition: String(p.disposition), rationale: p.rationale || '', followup: p.followup || '' });
    if (r.ok) written++; else skipped++;
  }

  recordRun();
  appendOversightEvent('scribe_triage_run', { ok: true, batch: batch.length, proposals: proposals.length, written, skipped, open_untriaged: rows.length });
  console.log(JSON.stringify({ ok: true, open_untriaged: rows.length, batch: batch.length, proposals: proposals.length, written, skipped }));
}

if (require.main === module) main();
module.exports = { collectUntriaged, parseProposals, buildPrompt, scribeFiles };

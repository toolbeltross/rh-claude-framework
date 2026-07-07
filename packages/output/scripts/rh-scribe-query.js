#!/usr/bin/env node
// rh-scribe-query.js — read the open scribe backlog for the /scribe disposition
// UI. md files are canonical (complete); the Postgres shadow lags, so we read
// the row list from md (strict parser) and OVERLAY any LLM proposal from the DB
// by (bucket, source_file, row_id). PLAN-2026-06-15-scribe-disposition-ui.
//
// Usage: rh-scribe-query.js [--status open] [--bucket cleanup|recommendations] [--json]
// Output: JSON { generatedAt, counts, rows:[...] }. Always JSON on stdout.

const path = require('path');
const { config } = require('./lib/config');
const scribeMd = require('./lib/scribe-md');
const scribeDb = require('./lib/scribe-db');

function parseArgs(argv) {
  const o = { status: 'open' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--status') o.status = argv[++i];
    else if (a === '--bucket') o.bucket = argv[++i];
    else if (a === '--all') o.status = null;
  }
  return o;
}

function norm(p) { return String(p).replace(/\\/g, '/'); }

// Same canonical set as rh-scribe-triage.js (cleanup + recommendations at the
// workspace root + the oversight-system copy).
function scribeFiles() {
  const ws = norm(config.workspace);
  const ovr = norm(config.oversightDir);
  return [
    { file: ws + '/cleanup.md', bucket: 'cleanup', scope: 'workspace' },
    { file: ws + '/recommendations.md', bucket: 'recommendations', scope: 'workspace' },
    { file: ovr + '/cleanup.md', bucket: 'cleanup', scope: 'oversight-system' },
    { file: ovr + '/recommendations.md', bucket: 'recommendations', scope: 'oversight-system' },
  ];
}

function ageDays(ts) {
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return null;
  return Math.round((Date.now() - t) / 86400000);
}

// Proposal overlay: map "bucket|source|id" → {disposition, rationale, followup, at}.
function proposalMap() {
  const m = new Map();
  const res = scribeDb.readRows({});
  if (!res.ok || !res.rows) return m;
  for (const r of res.rows) {
    if (!r.proposed_at) continue;
    m.set(`${r.bucket}|${norm(r.source_file || '')}|${r.row_id}`, {
      proposed_disposition: r.proposed_disposition,
      proposed_rationale: r.proposed_rationale,
      proposed_followup: r.proposed_followup,
      proposed_at: r.proposed_at,
    });
  }
  return m;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const proposals = proposalMap();
  const rows = [];
  const counts = { open_total: 0, proposed: 0, by_bucket: {} };

  for (const { file, bucket, scope } of scribeFiles()) {
    if (args.bucket && bucket !== args.bucket) continue;
    const { ok, rows: mdRows } = scribeMd.readRows(file);
    if (!ok) continue;
    for (const r of mdRows) {
      if (args.status && r.status !== args.status) continue;
      const key = `${bucket}|${norm(file)}|${r.id}`;
      const p = proposals.get(key) || {};
      const row = {
        id: r.id, ts: r.ts, session: r.session, text: r.text, status: r.status,
        bucket, scope, source_file: norm(file), age_days: ageDays(r.ts),
        proposed_disposition: p.proposed_disposition || null,
        proposed_rationale: p.proposed_rationale || null,
        proposed_followup: p.proposed_followup || null,
      };
      rows.push(row);
      if (r.status === 'open') {
        counts.open_total++;
        counts.by_bucket[bucket] = (counts.by_bucket[bucket] || 0) + 1;
      }
      if (row.proposed_disposition) counts.proposed++;
    }
  }

  // Oldest first — the daily review works the longest-lingering rows first.
  rows.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), counts, rows }));
}

try { main(); } catch (e) {
  console.log(JSON.stringify({ error: String(e.message || e), counts: { open_total: 0, by_bucket: {}, proposed: 0 }, rows: [] }));
  process.exit(1);
}

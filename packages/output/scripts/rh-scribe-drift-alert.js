#!/usr/bin/env node
// rh-scribe-drift-alert.js — daily VISIBILITY for scribe silent-loss drift.
//
// Incident F-15 (2026-06-27): rh-learnings-write.js reported {ok:true} for 66
// learnings whose .md never landed (literal-tilde path → withLock ENOENT →
// undefined, discarded). They were caught only because a daily parity audit was
// wired in (M-4) — but that audit's db_only count only lands in daily-regen.log,
// which nobody reads. This script closes the "we have a detector vs we'll
// actually notice" gap: it computes the learnings db_only count (DB shadow rows
// with NO canonical .md = a silent md-write loss, recoverable from
// scribe_rows.content) and, when > 0, surfaces ONE deduped OPEN row to
// recommendations.md — the place the user actually reviews. Completes the
// already-steward-approved M-4 intent ("caught without a human asking").
//
// READ-ONLY w.r.t. learnings md/DB. Its only write is the recommendations.md
// alert row, via the canonical rh-scribe-table-write.js helper. Non-blocking:
// exits 0 on no-drift, scribeDb-off, or any error (so it never aborts daily-regen).

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { config } = require('./lib/config');
const sdb = require('./lib/scribe-db');

function out(o) { console.log(JSON.stringify(o)); }

function main() {
  if (!config.scribeDb) { out({ skipped: true, reason: 'scribeDb-off' }); return; }

  const dir = path.join(config.claudeDir, 'memory-shared', 'learnings');
  let onDisk;
  try {
    onDisk = new Set(fs.readdirSync(dir).filter(f => f.endsWith('.md') && f !== 'MEMORY.md').map(f => f.slice(0, -3)));
  } catch (e) { out({ skipped: true, reason: 'learnings-dir-unreadable: ' + e.message }); return; }

  const q = sdb.runSql("SELECT DISTINCT row_id FROM scribe_rows WHERE bucket='learnings';");
  if (!q.ok) { out({ skipped: true, reason: 'db-query-failed: ' + q.error }); return; }
  const ids = (q.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
  const dbOnly = ids.filter(id => !onDisk.has(id));

  if (dbOnly.length === 0) { out({ drift: false, dbOnly: 0 }); return; }

  // Drift present — surface it. Dedup by a STABLE id so the row appears once
  // (until the user recovers + closes it), not once per day.
  const recs = config.workspace ? path.join(config.workspace, 'recommendations.md') : null;
  if (!recs) { out({ drift: true, dbOnly: dbOnly.length, reason: 'no-workspace-path' }); return; }
  const id = crypto.createHash('sha256').update('scribe-parity-drift-learnings').digest('hex').slice(0, 10);
  let existing = '';
  try { existing = fs.readFileSync(recs, 'utf8'); } catch {}
  if (existing.includes('| ' + id + ' |')) { out({ drift: true, dbOnly: dbOnly.length, alreadyFlagged: true, id }); return; }

  const samples = dbOnly.slice(0, 5).join(', ');
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const text = `SCRIBE SILENT-LOSS DRIFT: ${dbOnly.length} learnings in the postgres shadow have NO canonical .md (db_only) — recoverable from scribe_rows.content. Investigate per incident F-15 (rh-scribe-parity-audit + recover). e.g.: ${samples}`;
  const row = JSON.stringify([{ id, ts, session: 'drift-al', text, status: 'open' }]);
  const w = spawnSync('node', [path.join(__dirname, 'rh-scribe-table-write.js'), '--target', recs], {
    input: row, encoding: 'utf8', timeout: 30000,
  });
  out({ drift: true, dbOnly: dbOnly.length, flagged: w.status === 0, id, samples });
}

try { main(); } catch (e) { out({ skipped: true, reason: 'threw: ' + (e.message || e) }); }

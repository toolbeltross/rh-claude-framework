#!/usr/bin/env node
/**
 * rh-scribe-row-update.js — atomic in-place status flip of ONE scribe row in
 * a canonical md file, by (source_file, row_id). The first programmatic
 * mutation of existing scribe rows (rh-scribe-table-write.js only appends).
 *
 * PLAN-2026-06-15-scribe-disposition-ui (closes F-K). Invoked by the
 * telemetry server's POST /api/scribe/disposition. md stays canonical; the
 * Postgres shadow is synced best-effort after the md write.
 *
 * Steward conditions (effervescent-enchanting-hopcroft.md):
 *  - C2: exactly one row must match (handled by scribe-md.replaceRowStatus).
 *  - C3: sentinel preserved (asserted by scribe-md.replaceRowStatus).
 *  - C4: source_file must be in the config-driven allowlist; To Do/Migration
 *        and any non-allowlisted path are rejected.
 *
 * Usage:
 *   node rh-scribe-row-update.js --source <abs.md> --id <hex> --status "<text>" [--bucket cleanup] [--dry-run]
 * Exit: 0 ok (prints JSON), 1 error (prints JSON {ok:false,error}).
 */

const fs = require('fs');
const path = require('path');
const { config } = require('./lib/config');
const { withLock } = require('./lib/file-lock');
const scribeMd = require('./lib/scribe-md');
const scribeDb = require('./lib/scribe-db');

const LOCK_RETRIES = 30;
const LOCK_BASE_WAIT_MS = 50;

function parseArgs(argv) {
  const o = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source') o.source = argv[++i];
    else if (a === '--id') o.id = argv[++i];
    else if (a === '--status') o.status = argv[++i];
    else if (a === '--bucket') o.bucket = argv[++i];
    else if (a === '--dry-run') o.dryRun = true;
  }
  return o;
}

function norm(p) { return String(p || '').replace(/\\/g, '/'); }

/** C4: config-driven allowlist of canonical scribe files.
 * 2026-07-06: oversightDir-derived entries retired — the workspace-root files
 * are the single canonical location; oversight-dir copies were stale
 * cwd-walkup leftovers (see rh-doc-placement.md, workspace-vs-project trap). */
function allowedSources() {
  const ws = norm(config.workspace);
  const set = new Set();
  for (const b of ['cleanup.md', 'recommendations.md', 'learnings.md']) set.add(ws + '/' + b);
  return set;
}

function bucketFromFile(p) {
  return { 'cleanup.md': 'cleanup', 'recommendations.md': 'recommendations', 'learnings.md': 'learnings' }[path.basename(norm(p))];
}

function fail(msg) { console.log(JSON.stringify({ ok: false, error: msg })); process.exit(1); }

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.source || !args.id || args.status == null) fail('--source, --id, --status are required');

  const source = norm(path.resolve(args.source));
  // C4 — reject anything outside the allowlist (covers To Do/Migration, Archive, per-project copies).
  if (!allowedSources().has(source)) {
    return fail('write-target not in allowlist: ' + source);
  }
  const bucket = args.bucket || bucketFromFile(source);
  if (!bucket) fail('cannot infer bucket from ' + source);
  if (!fs.existsSync(source)) fail('source file does not exist: ' + source);

  if (args.dryRun) {
    const { ok, rows } = scribeMd.readRows(source);
    const match = ok ? rows.filter(r => r.id === args.id) : [];
    console.log(JSON.stringify({ ok: match.length === 1, dryRun: true, source, id: args.id,
      matches: match.length, currentStatus: match[0] && match[0].status, newStatus: args.status }));
    return;
  }

  // Atomic md read-modify-write (C2/C3 enforced inside replaceRowStatus).
  // withLock returns undefined ONLY on lock-acquisition failure and otherwise
  // propagates the callback's return value — so the callback must return a
  // truthy object to be distinguishable from a lock failure.
  const result = withLock(source, () => {
    const content = fs.readFileSync(source, 'utf8');
    const r = scribeMd.replaceRowStatus(content, args.id, args.status);
    if (!r.ok) return { ok: false, error: r.error };
    fs.writeFileSync(source, r.content, 'utf8');
    return { ok: true, oldStatus: r.oldStatus };
  }, { retries: LOCK_RETRIES, baseWaitMs: LOCK_BASE_WAIT_MS });

  if (result === undefined) fail('could not acquire lock on ' + source);
  if (!result.ok) fail(result.error);

  // Best-effort DB shadow sync (md already canonical-updated). Re-read the row
  // to upsert full content + new status, so the shadow reflects md even if the
  // row predated dual-write and was never shadowed.
  let dbShadow = { ok: true, skipped: true };
  try {
    const { rows } = scribeMd.readRows(source);
    const row = rows.find(r => r.id === args.id);
    if (row) {
      dbShadow = scribeDb.writeRow({
        bucket, row_id: row.id, session_id: row.session ? String(row.session).slice(0, 8) : null,
        ts: /^\d{4}-\d{2}-\d{2}$/.test(row.ts) ? row.ts : row.ts,
        content: row.text, status: row.status, source_file: source,
        raw_line: `| ${row.id} | ${row.ts} | ${row.session} | ${row.text} | ${row.status} |`,
      });
    }
  } catch (e) { dbShadow = { ok: false, error: String(e.message || e) }; }

  console.log(JSON.stringify({
    ok: true, source, id: args.id, bucket,
    oldStatus: result.oldStatus, newStatus: args.status,
    dbShadow: dbShadow.skipped ? 'off' : (dbShadow.ok ? 'written' : 'failed (md unaffected)'),
  }));
}

try { main(); } catch (e) { fail('fatal: ' + String(e.message || e)); }

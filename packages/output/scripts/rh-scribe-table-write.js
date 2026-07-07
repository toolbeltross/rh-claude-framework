#!/usr/bin/env node
/**
 * rh-scribe-table-write.js — atomic, sentinel-aware row appender for the
 * tabular scribe files (recommendations.md, cleanup.md).
 *
 * Origin: 2026-05-08 (P1-7). The multiscope agent was issuing multi-step
 * bash sequences (sentinel hygiene → row appends → sentinel re-add) that
 * were producing recurring mid-file sentinel anomalies. This script
 * centralizes the well-tested logic from rh-scribe-prefilter.js's
 * appendRowsToFile() into a single CLI invocation. Multiscope calls it
 * once per target file; ordering, sentinel position, and lock acquisition
 * are guaranteed by one process.
 *
 * Usage:
 *   echo '[{"id":"...","ts":"...","session":"...","text":"...","status":"open"}, ...]' | \
 *     node rh-scribe-table-write.js --target /path/to/recommendations.md
 *
 *   OR (single row, no JSON):
 *   node rh-scribe-table-write.js --target /path/to/cleanup.md \
 *     --id <hex8-16> --session <8char> --text "..." [--status open]
 *
 * Exit:
 *   0 — wrote N rows (printed to stdout: { ok, wrote, target, sentinelPosition })
 *   1 — error (lock failure, target unwritable, malformed JSON)
 *
 * Sentinel handling: matches rh-scribe-prefilter.js appendRowsToFile()
 * exactly. Reads the file once inside the lock, finds the LAST sentinel,
 * inserts new rows before it (or appends + adds sentinel if absent or
 * if there's content after the existing sentinel). One write under lock.
 *
 * Anti-bug: removes ANY interior sentinels before the final write so
 * repeated invocations cannot accumulate duplicate sentinels. This was
 * the gap in rh-scribe-prefilter.js's appendRowsToFile() — its `else`
 * branch (sentinel exists but has trailing content) added a NEW sentinel
 * without removing the existing mid-file one, allowing two-sentinel
 * states to persist.
 */

const fs = require('fs');
const path = require('path');
const { withLock } = require('./lib/file-lock');
const scribeDb = require('./lib/scribe-db');
// Defensive: a missing/broken context-db.js (e.g. an older install that predates
// the lib) must NEVER break the canonical md write. Degrade to no-ops; the 3rd
// write simply stays off until the lib is present.
let contextDb;
try {
  contextDb = require('./lib/context-db');
} catch {
  contextDb = {
    upsertIngestSource: () => ({ ok: true, skipped: true }),
    upsertMemoryArtifact: () => ({ ok: true, skipped: true }),
    insertMemoryObservation: () => ({ ok: true, skipped: true }),
    logDualWrite: () => ({ ok: true, skipped: true }),
    canonicalSourceFile: (p) => String(p == null ? '' : p).replace(/\\/g, '/'),
  };
}

const SENTINEL = '<!-- scribe-done -->';
const LOCK_RETRIES = 30;
const LOCK_BASE_WAIT_MS = 50;

// Header self-heal (2026-07-06). Bare-append historically produced headerless
// files (rows with no title/schema/table-header). When the target is missing
// or lacks the table-header line, prepend the canonical header block for the
// bucket before appending rows. Only applies to targets whose basename maps
// to a known bucket — arbitrary targets keep the old bare-append behavior.
// Keep in sync with rh-scribe-prefilter.js — both writers must produce the
// same on-disk shape.
const TABLE_HEADER_PREFIX = '| id | ts | session |';
const BUCKET_TITLES = {
  'cleanup.md': 'Cleanup items',
  'recommendations.md': 'Recommendations',
  'learnings.md': 'Learnings',
};
function canonicalHeaderBlock(filePath) {
  const title = BUCKET_TITLES[path.basename(filePath)];
  if (!title) return null;
  return [
    `# ${title} (cross-session scribe log)`,
    '',
    'Schema: `id | ts | session | text | status`. Status is `open` by default; flips via triage dispositions or /rh-quit curation. Forward-looking — capture what needs follow-up.',
    '',
    '| id | ts | session | text | status |',
    '|---|---|---|---|---|',
    '',
  ].join('\n');
}

function parseArgs(argv) {
  const out = { target: null, rows: [], dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target') out.target = argv[++i];
    else if (a === '--id') out._id = argv[++i];
    else if (a === '--session') out._session = argv[++i];
    else if (a === '--text') out._text = argv[++i];
    else if (a === '--ts') out._ts = argv[++i];
    else if (a === '--status') out._status = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
  }
  return out;
}

function rowFromArgs(args) {
  return {
    id: args._id,
    ts: args._ts || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    session: args._session,
    text: args._text,
    status: args._status || 'open',
  };
}

function buildRowLine(row) {
  // Schema: | id | ts | session | text | status |
  const text = String(row.text || '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
  const session = String(row.session || '').slice(0, 8);
  return `| ${row.id} | ${row.ts} | ${session} | ${text} | ${row.status || 'open'} |\n`;
}

function readRowsFromStdin() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch { return []; }
  if (!raw.trim()) return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) {
    throw new Error(`stdin must be JSON array of row objects: ${e.message}`);
  }
  if (!Array.isArray(parsed)) throw new Error('stdin JSON must be an array');
  return parsed;
}

function appendAtomic(target, rowLines) {
  return withLock(target, () => {
    let content = '';
    if (fs.existsSync(target)) {
      content = fs.readFileSync(target, 'utf8');
    }

    // Strip ALL sentinel occurrences (interior + EOF) — closes the
    // two-sentinel-accumulation gap that rh-scribe-prefilter.js had.
    const stripped = content
      .split('\n')
      .filter(l => l.trim() !== SENTINEL)
      .join('\n');

    let body = stripped;

    // Header self-heal: missing file or content without the table-header
    // line gains the canonical header block (prepended, existing content
    // preserved) before the new rows are appended.
    const hasHeader = body.split('\n').some(l => l.trim().startsWith(TABLE_HEADER_PREFIX));
    if (!hasHeader) {
      const header = canonicalHeaderBlock(target);
      if (header) body = header + (body.trim().length > 0 ? body : '');
    }

    // Ensure trailing newline before appending rows.
    if (body.length > 0 && !body.endsWith('\n')) body += '\n';

    // Append new rows + single sentinel at EOF.
    let newContent = body + rowLines.join('') + SENTINEL + '\n';

    fs.writeFileSync(target, newContent, 'utf8');
    return rowLines.length;
  }, { retries: LOCK_RETRIES, baseWaitMs: LOCK_BASE_WAIT_MS });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.target) {
    console.error('--target is required');
    process.exit(1);
  }

  let rows;
  if (args._id || args._text) {
    rows = [rowFromArgs(args)];
  } else {
    try {
      rows = readRowsFromStdin();
    } catch (e) {
      console.error(`error: ${e.message}`);
      process.exit(1);
    }
  }

  if (rows.length === 0) {
    console.log(JSON.stringify({ ok: true, wrote: 0, target: args.target, note: 'no rows to write' }));
    return;
  }

  // Validate each row has required fields.
  for (const r of rows) {
    if (!r.id || !r.text || !r.session) {
      console.error(`error: each row needs id, text, session — got ${JSON.stringify(r)}`);
      process.exit(1);
    }
  }

  const rowLines = rows.map(buildRowLine);

  if (args.dryRun) {
    console.log(JSON.stringify({
      ok: true,
      wrote: 0,
      target: args.target,
      dryRun: true,
      wouldWriteLines: rowLines,
    }, null, 2));
    return;
  }

  // Resolve target to absolute. Create parent dir if needed.
  const targetAbs = path.resolve(args.target);
  const targetDir = path.dirname(targetAbs);
  if (!fs.existsSync(targetDir)) {
    try { fs.mkdirSync(targetDir, { recursive: true }); } catch {}
  }

  const wrote = appendAtomic(targetAbs, rowLines);
  if (wrote === undefined) {
    console.error(`error: could not acquire lock on ${targetAbs} after ${LOCK_RETRIES} retries`);
    process.exit(1);
  }

  // Postgres shadow write (Phase 2, PLAN-2026-06-11-scribe-postgres-fts).
  // Best-effort AFTER the canonical md write; failures are logged by
  // scribe-db and never affect this CLI's result.
  const bucket = { 'recommendations.md': 'recommendations', 'cleanup.md': 'cleanup', 'learnings.md': 'learnings' }[path.basename(targetAbs)];
  let dbShadow = { ok: true, skipped: true };
  if (bucket) {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const res = scribeDb.writeRow({
        bucket,
        row_id: String(r.id),
        session_id: r.session ? String(r.session).slice(0, 8) : null,
        ts: r.ts || null,
        content: String(r.text || ''),
        status: r.status || 'open',
        source_file: targetAbs,
        raw_line: rowLines[i].trimEnd(),
      });
      if (!res.ok) dbShadow = res;
      else if (!res.skipped && dbShadow.skipped) dbShadow = { ok: true, skipped: false };
    }
  }

  // Context-model 3rd write (Phase 3.2, PLAN-2026-06-13-context-db). Best-effort,
  // flag-gated (contextDb), AFTER md + rh_scribe. Routed through the privacy gate:
  // register the source (content-scanned), then write each row's artifact only if
  // the source is mirror-eligible. FAIL-CLOSED: if source registration fails we do
  // NOT write content ungated. Failures logged by context-db; md never affected.
  let ctxShadow = { ok: true, skipped: true };
  if (bucket) {
    try {
      const sourceKind = bucket === 'learnings' ? 'learnings_md' : 'scribe_md';
      let fileContent = '';
      try { fileContent = fs.readFileSync(targetAbs, 'utf8'); } catch {}
      const src = contextDb.upsertIngestSource({ canonical_path: targetAbs, source_kind: sourceKind, content: fileContent });
      if (src.skipped) {
        ctxShadow = src; // contextDb off — dormant
      } else if (!src.ok || !src.source_id) {
        // Fail closed: never write content rows without a registered source.
        ctxShadow = { ok: false, error: 'ingest source registration failed: ' + (src.error || 'no source_id') };
        contextDb.logDualWrite({ entity_type: 'ctx_ingest_source', entity_natural_key: targetAbs, result: 'failed', error: src.error, md_source_file: targetAbs, triggering_writer: 'rh-scribe-table-write' });
      } else {
        const sourceId = src.source_id;
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i];
          const art = contextDb.upsertMemoryArtifact({
            bucket,
            row_id: String(r.id),
            source_file: targetAbs,
            source_id: sourceId,
            memory_type: bucket === 'learnings' ? 'semantic' : 'procedural',
            status: r.status || 'open',
            session_id_short: r.session ? String(r.session).slice(0, 8) : undefined,
            ts: r.ts || undefined,
            body_distilled: String(r.text || ''),
            raw_line: rowLines[i].trimEnd(),
          });
          contextDb.logDualWrite({
            entity_type: 'ctx_memory_artifact',
            entity_natural_key: `${bucket}|${contextDb.canonicalSourceFile(targetAbs)}|${r.id}`,
            result: art.skipped ? 'skipped' : (art.gated ? 'skipped' : (art.ok ? 'ok' : 'failed')),
            error: art.ok ? undefined : art.error,
            md_source_file: targetAbs,
            triggering_writer: 'rh-scribe-table-write',
          });
          if (!art.ok) ctxShadow = art;
          else if (!art.skipped && ctxShadow.skipped) ctxShadow = { ok: true, skipped: false };
        }
      }
    } catch (e) { ctxShadow = { ok: false, error: String(e.message || e) }; }
  }

  console.log(JSON.stringify({
    ok: true,
    wrote,
    target: targetAbs,
    sentinelPosition: 'eof',
    dbShadow: dbShadow.skipped ? 'off' : (dbShadow.ok ? 'written' : 'failed (md unaffected)'),
    ctxShadow: ctxShadow.skipped ? 'off' : (ctxShadow.ok ? 'written' : 'failed (md unaffected)'),
  }));
}

try { main(); } catch (e) {
  console.error(`fatal: ${e.message}`);
  process.exit(1);
}

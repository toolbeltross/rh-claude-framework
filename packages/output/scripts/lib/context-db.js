/**
 * context-db.js — best-effort postgres writers for the ctx_* unified context
 * model (the "3rd write"). PLAN-2026-06-13-context-db.md Phase 3.1.
 *
 * Same machinery & guarantees as scribe-db.js (the existing 2nd write):
 *  - NO npm deps. Deployed under ~/.claude/scripts/lib/ where there is no
 *    node_modules, so it reuses scribe-db.js's psql plumbing (spawnSync psql,
 *    pgpass -w auth, SQL via stdin, PGCLIENTENCODING=UTF8 to dodge cp1252
 *    arg-mangling). Connection params are the shared scribeDb* config — ctx_*
 *    lives in the SAME rh_scribe database.
 *  - Best-effort & non-blocking. Every failure is swallowed and logged as a
 *    context_db_write_failed oversight event. md/jsonl stay CANON; a ctx_
 *    failure must never block or fail a caller's md write.
 *  - No-op (skipped:true) unless config.contextDb is true (independent of the
 *    scribeDb flag — the 2nd and 3rd writes toggle separately).
 *
 * Writers in this module (Phase 3.1):
 *   upsertMemoryArtifact(row)    -> ctx_memory_artifact
 *                                   natural key (bucket, source_file, row_id)
 *   insertMemoryObservation(row) -> ctx_memory_observation
 *                                   natural key (artifact_id, obs_hash); the
 *                                   artifact may be addressed by its uuid OR
 *                                   resolved from (bucket, source_file, row_id)
 *   logDualWrite(entry)          -> ctx_dualwrite_log  (append-only audit)
 *
 * Deliberately NOT here yet (later phases — do not wire ahead of these):
 *  - ctx_ingest_source upsert + the privacy gate (Phase 3.4, steward BLOCK 2).
 *    Until that lands, content writers accept source_id only when a caller
 *    supplies one; nothing in this repo calls these writers on live data.
 *  - Any wiring into rh-scribe-table-write.js / rh-learnings-write.js
 *    (Phase 3.2 / 3.3). This module is import-only until the privacy gate is in.
 */

const crypto = require('crypto');
const { config } = require('./config');
// Reuse scribe-db's psql plumbing verbatim so both shadows behave identically.
const { runSql, dollarQuote, canonicalSourceFile } = require('./scribe-db');

let appendOversightEvent = () => {};
try { ({ appendOversightEvent } = require('./oversight-events')); } catch { /* optional */ }

function sha256(s) {
  return crypto.createHash('sha256').update(String(s == null ? '' : s), 'utf8').digest('hex');
}

// SQL literal for a value given its column type. NULL/undefined -> NULL.
// dollarQuote makes the payload injection-safe; the ::cast keeps psql from
// guessing the type for text-quoted uuids / timestamps / json / ints.
function lit(val, type) {
  if (val === null || val === undefined || val === '') {
    // empty string is a legitimate text value, but for typed columns it is
    // never valid — treat '' as NULL for non-text to avoid cast errors.
    if (val === '' && type === 'text') return dollarQuote('');
    return 'NULL';
  }
  const q = dollarQuote(String(val));
  switch (type) {
    case 'uuid':        return q + '::uuid';
    case 'timestamptz': return q + '::timestamptz';
    case 'date':        return q + '::date';
    case 'int':         return q + '::int';
    case 'jsonb':       return q + '::jsonb';
    case 'text':
    default:            return q;
  }
}

// ---- ctx_memory_artifact ---------------------------------------------------

// column -> type. Order is the INSERT column order. Natural-key columns first.
const ARTIFACT_FIELDS = {
  bucket: 'text', source_file: 'text', row_id: 'text',
  source_id: 'uuid',
  memory_type: 'text', severity: 'text', status: 'text',
  session_id_full: 'uuid', session_id_short: 'text',
  title: 'text', body_distilled: 'text', raw_line: 'text', content_hash: 'text',
  ts: 'timestamptz', t_valid: 'timestamptz', t_invalid: 'timestamptz',
  superseded_by: 'uuid', token_estimate: 'int', frontmatter: 'jsonb',
  embedding_model_id: 'text',
};
const ARTIFACT_KEY = ['bucket', 'source_file', 'row_id'];

// Build the artifact upsert SQL from whatever fields the row provides. Exported
// for shape tests so the SQL can be asserted without a live database.
function _buildArtifactSql(row) {
  const r = { ...row, source_file: canonicalSourceFile(row.source_file) };
  if (r.content_hash === undefined && (r.title != null || r.body_distilled != null)) {
    r.content_hash = sha256((r.title || '') + '\n' + (r.body_distilled || ''));
  }
  const cols = Object.keys(ARTIFACT_FIELDS).filter(c => r[c] !== undefined);
  const vals = cols.map(c => lit(r[c], ARTIFACT_FIELDS[c]));
  const updatable = cols.filter(c => !ARTIFACT_KEY.includes(c));
  const setClause = updatable.length
    ? updatable.map(c => `${c} = EXCLUDED.${c}`).join(', ') + ', updated_at = now()'
    : 'updated_at = now()';
  return (
    `INSERT INTO ctx_memory_artifact (${cols.join(', ')}) VALUES (${vals.join(', ')}) ` +
    `ON CONFLICT (bucket, source_file, row_id) DO UPDATE SET ${setClause} ` +
    `RETURNING id;`
  );
}

/**
 * Upsert one ctx_memory_artifact row. Never throws.
 * Required: bucket, row_id, source_file (the natural key; all NOT NULL).
 * @returns {{ok:boolean, skipped?:boolean, id?:string, error?:string}}
 */
function upsertMemoryArtifact(row) {
  try {
    if (!config.contextDb) return { ok: true, skipped: true };
    for (const k of ARTIFACT_KEY) {
      if (!row || !row[k]) return { ok: false, error: `upsertMemoryArtifact: missing ${k}` };
    }
    const res = runSql(_buildArtifactSql(row));
    if (!res.ok) {
      appendOversightEvent('context_db_write_failed', {
        entity: 'ctx_memory_artifact', bucket: row.bucket, row_id: row.row_id, error: res.error,
      });
      return res;
    }
    return { ok: true, id: (res.stdout || '').trim() || undefined };
  } catch (e) {
    try { appendOversightEvent('context_db_write_failed', { entity: 'ctx_memory_artifact', error: String(e.message || e) }); } catch {}
    return { ok: false, error: String(e.message || e) };
  }
}

// ---- ctx_memory_observation ------------------------------------------------

const OBS_FIELDS = {
  obs_date: 'date', session_id_full: 'uuid', session_id_short: 'text',
  observation: 'text', obs_hash: 'text', t_invalid: 'timestamptz', source_id: 'uuid',
};

// Build the observation insert SQL. The artifact is addressed either by an
// explicit artifact_id (uuid) or resolved from its natural key via a subselect.
// ON CONFLICT (artifact_id, obs_hash) DO NOTHING — observations are immutable.
function _buildObservationSql(row) {
  const r = { ...row };
  if (!r.obs_hash) r.obs_hash = sha256(r.observation);
  const cols = Object.keys(OBS_FIELDS).filter(c => r[c] !== undefined);
  const vals = cols.map(c => lit(r[c], OBS_FIELDS[c]));

  if (r.artifact_id) {
    const allCols = ['artifact_id', ...cols];
    const allVals = [lit(r.artifact_id, 'uuid'), ...vals];
    return (
      `INSERT INTO ctx_memory_observation (${allCols.join(', ')}) ` +
      `VALUES (${allVals.join(', ')}) ` +
      `ON CONFLICT (artifact_id, obs_hash) DO NOTHING RETURNING id;`
    );
  }
  // Resolve artifact_id from the natural key. If no artifact matches, the
  // SELECT yields no rows and nothing is inserted (best-effort no-op).
  const allCols = ['artifact_id', ...cols];
  const selVals = vals.join(', ');
  return (
    `INSERT INTO ctx_memory_observation (${allCols.join(', ')}) ` +
    `SELECT a.id${selVals ? ', ' + selVals : ''} FROM ctx_memory_artifact a ` +
    `WHERE a.bucket = ${lit(r.bucket, 'text')} AND a.source_file = ${lit(canonicalSourceFile(r.source_file), 'text')} AND a.row_id = ${lit(r.row_id, 'text')} ` +
    `ON CONFLICT (artifact_id, obs_hash) DO NOTHING RETURNING id;`
  );
}

/**
 * Insert one ctx_memory_observation row (immutable; dup-safe). Never throws.
 * Address the parent artifact with either `artifact_id` OR the natural key
 * (`bucket`, `source_file`, `row_id`). `obs_hash` defaults to sha256(observation).
 * @returns {{ok:boolean, skipped?:boolean, id?:string, inserted?:boolean, error?:string}}
 */
function insertMemoryObservation(row) {
  try {
    if (!config.contextDb) return { ok: true, skipped: true };
    if (!row || !row.observation) return { ok: false, error: 'insertMemoryObservation: missing observation' };
    const hasTarget = row.artifact_id || (row.bucket && row.source_file && row.row_id);
    if (!hasTarget) return { ok: false, error: 'insertMemoryObservation: need artifact_id or (bucket, source_file, row_id)' };
    const res = runSql(_buildObservationSql(row));
    if (!res.ok) {
      appendOversightEvent('context_db_write_failed', { entity: 'ctx_memory_observation', error: res.error });
      return res;
    }
    const id = (res.stdout || '').trim() || undefined;
    return { ok: true, id, inserted: Boolean(id) };
  } catch (e) {
    try { appendOversightEvent('context_db_write_failed', { entity: 'ctx_memory_observation', error: String(e.message || e) }); } catch {}
    return { ok: false, error: String(e.message || e) };
  }
}

// ---- ctx_dualwrite_log (append-only audit) ---------------------------------

const DUALWRITE_FIELDS = {
  entity_type: 'text', entity_natural_key: 'text', result: 'text',
  error: 'text', md_source_file: 'text', triggering_writer: 'text',
};

function _buildDualWriteSql(entry) {
  const e = { ...entry, md_source_file: canonicalSourceFile(entry.md_source_file) };
  const cols = Object.keys(DUALWRITE_FIELDS).filter(c => e[c] !== undefined);
  const vals = cols.map(c => lit(e[c], DUALWRITE_FIELDS[c]));
  return `INSERT INTO ctx_dualwrite_log (${cols.join(', ')}) VALUES (${vals.join(', ')}) RETURNING id;`;
}

/**
 * Append one ctx_dualwrite_log audit row. Never throws.
 * Required: entity_type, result ('ok' | 'skipped' | 'failed').
 * @returns {{ok:boolean, skipped?:boolean, id?:string, error?:string}}
 */
function logDualWrite(entry) {
  try {
    if (!config.contextDb) return { ok: true, skipped: true };
    if (!entry || !entry.entity_type || !entry.result) {
      return { ok: false, error: 'logDualWrite: missing entity_type or result' };
    }
    const res = runSql(_buildDualWriteSql(entry));
    if (!res.ok) {
      // Logging the failure of the audit log itself only goes to oversight.
      appendOversightEvent('context_db_write_failed', { entity: 'ctx_dualwrite_log', error: res.error });
      return res;
    }
    return { ok: true, id: (res.stdout || '').trim() || undefined };
  } catch (e) {
    try { appendOversightEvent('context_db_write_failed', { entity: 'ctx_dualwrite_log', error: String(e.message || e) }); } catch {}
    return { ok: false, error: String(e.message || e) };
  }
}

module.exports = {
  upsertMemoryArtifact, insertMemoryObservation, logDualWrite,
  sha256,
  // re-exported scribe-db plumbing (parity with scribe-db's surface):
  runSql, dollarQuote, canonicalSourceFile,
  // exported for shape tests (no live DB needed):
  _buildArtifactSql, _buildObservationSql, _buildDualWriteSql, lit,
};

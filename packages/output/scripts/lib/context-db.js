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
    case 'bigint':      return q + '::bigint';
    case 'numeric':     return q + '::numeric';
    case 'jsonb':       return q + '::jsonb';
    case 'text':
    default:            return q;
  }
}

// ---- privacy gate (Phase 3.4, steward BLOCK 2) -----------------------------
//
// The ctx_* DB is queryable/joinable data, so it must never mirror the BODY of
// a private source. Enforcement is per-SOURCE-FILE, fail-closed: every source
// defaults to 'review-required' and content writers (below) physically refuse
// to shadow text unless the source is 'clean'/'redacted'. Dispositions:
//   blocklisted-skipped — path under a configured private dir; never mirrored
//   review-required     — default; also: no content scanned, PII hit, big prose
//                         log, or unknown kind
//   clean               — safe to mirror (non-private + a curated kind + content
//                         actually scanned + PII-clean)
//   redacted            — manually cleaned (never assigned automatically here)
// Bump BLOCKLIST_VERSION whenever the rules below change so each source row
// records which ruleset classified it.
//
// Policy (user direction 2026-06-14): hard-exclude private paths; CONTENT SCAN,
// NEVER SLUG-ONLY (a source is never 'clean' without its content being scanned —
// path/kind alone is insufficient); allow curated structured kinds after a clean
// scan; default-DENY the big prose logs (manual promotion only).
const BLOCKLIST_VERSION = '2026-06-14.1';

// Conservative PII signatures (per rh-security.md: no SSNs/EINs/account numbers).
// False positives are SAFE here — they downgrade to review-required (fail toward
// NOT mirroring). Tuned to catch, not to be precise.
const PII_PATTERNS = [
  /\b\d{3}-\d{2}-\d{4}\b/,        // SSN  123-45-6789
  /\b\d{2}-\d{7}\b/,             // EIN  12-3456789
  /\b\d{13,19}\b/,               // long account / card numbers
];

// Curated, structured kinds: short/templated rows whose content the regex scan
// can vet with confidence. Eligible for auto-'clean' AFTER a content scan.
const CURATED_KINDS = new Set([
  'scribe_md', 'learnings_md', 'oversight_jsonl', 'telemetry_jsonl',
]);
// Big free-text logs: default-DENY even when the regex scan passes — a few
// patterns aren't enough confidence for prose/conversation. Manual promotion
// (set privacy_disposition explicitly) is the only path to 'clean' for these.
const PROSE_DENY_KINDS = new Set(['prose_md', 'transcript_jsonl']);

// Pure: decide a source's privacy disposition. privateDirs is injectable for
// tests; defaults to config.privateDirs (oversight.json, currently user-owned).
function classifyDisposition({ canonicalPath, sourceKind, content } = {}, privateDirs) {
  const dirs = privateDirs || config.privateDirs || [];
  const p = canonicalSourceFile(canonicalPath || '').toLowerCase();
  // 1. Hard-exclude private entries — regardless of kind or content.
  //    Two entry shapes (user direction 2026-06-14, "those names regardless
  //    where they reside"):
  //      • path-shaped (absolute, or contains '/') → PREFIX match on the path
  //      • bare-name token (no separator) → match ANYWHERE in the path OR the
  //        content (these names recur in many locations, not just as path roots)
  const lcContent = content == null ? '' : String(content).toLowerCase();
  for (const d of dirs) {
    const nd = canonicalSourceFile(String(d)).toLowerCase().replace(/\/+$/, '');
    if (!nd) continue;
    const pathShaped = nd.includes('/') || /^[a-z]:/.test(nd);
    if (pathShaped) {
      if (p === nd || p.startsWith(nd + '/')) return 'blocklisted-skipped';
    } else {
      // bare token: substring match on path or content (fail toward exclusion)
      if (p.includes(nd) || lcContent.includes(nd)) return 'blocklisted-skipped';
    }
  }
  // 2. CONTENT SCAN MANDATORY — never slug-only. No content => never clean.
  if (content == null || content === '') return 'review-required';
  // 3. PII scan — any hit holds the source for review.
  for (const re of PII_PATTERNS) if (re.test(String(content))) return 'review-required';
  // 4. Tier by kind (content has now been scanned clean). Big prose logs and
  //    unknown kinds default-deny; only curated structured kinds auto-clean.
  return CURATED_KINDS.has(sourceKind) ? 'clean' : 'review-required';
}

const INGEST_FIELDS = {
  canonical_path: 'text', source_kind: 'text', ingested_through: 'int',
  content_sha256: 'text', privacy_disposition: 'text', blocklist_version: 'text',
};

function _buildIngestSql(src) {
  const cols = Object.keys(INGEST_FIELDS).filter(c => src[c] !== undefined);
  const vals = cols.map(c => lit(src[c], INGEST_FIELDS[c]));
  const updatable = cols.filter(c => c !== 'canonical_path' && c !== 'source_kind');
  const setClause = (updatable.length ? updatable.map(c => `${c} = EXCLUDED.${c}`).join(', ') + ', ' : '')
    + 'last_verified_at = now()';
  return (
    `INSERT INTO ctx_ingest_source (${cols.join(', ')}) VALUES (${vals.join(', ')}) ` +
    `ON CONFLICT (canonical_path, source_kind) DO UPDATE SET ${setClause} ` +
    `RETURNING source_id, privacy_disposition;`
  );
}

/**
 * Upsert one ctx_ingest_source row, classifying its privacy disposition (unless
 * one is supplied explicitly). This is the gate's registration step — content
 * writers refuse sources that don't end up 'clean'/'redacted'. Never throws.
 * @param {{canonical_path:string, source_kind:string, content?:string, content_sha256?:string, ingested_through?:number, privacy_disposition?:string}} src
 * @returns {{ok:boolean, skipped?:boolean, source_id?:string, disposition?:string, error?:string}}
 */
function upsertIngestSource(src) {
  try {
    if (!config.contextDb) return { ok: true, skipped: true };
    if (!src || !src.canonical_path || !src.source_kind) {
      return { ok: false, error: 'upsertIngestSource: missing canonical_path or source_kind' };
    }
    const canonical = canonicalSourceFile(src.canonical_path);
    const disposition = src.privacy_disposition
      || classifyDisposition({ canonicalPath: canonical, sourceKind: src.source_kind, content: src.content });
    const row = {
      canonical_path: canonical,
      source_kind: src.source_kind,
      privacy_disposition: disposition,
      blocklist_version: src.blocklist_version || BLOCKLIST_VERSION,
    };
    if (src.ingested_through !== undefined) row.ingested_through = src.ingested_through;
    const sha = src.content != null ? sha256(src.content) : (src.content_sha256 || undefined);
    if (sha !== undefined) row.content_sha256 = sha;
    const res = runSql(_buildIngestSql(row));
    if (!res.ok) {
      appendOversightEvent('context_db_write_failed', { entity: 'ctx_ingest_source', canonical_path: canonical, error: res.error });
      return res;
    }
    const [source_id] = (res.stdout || '').split('|');
    return { ok: true, source_id: source_id || undefined, disposition };
  } catch (e) {
    try { appendOversightEvent('context_db_write_failed', { entity: 'ctx_ingest_source', error: String(e.message || e) }); } catch {}
    return { ok: false, error: String(e.message || e) };
  }
}

// SQL fragment that admits a content write only when its source_id resolves to
// a mirror-eligible disposition. Empty string when no source_id (caller-gated).
function _cleanSourceGuard(sourceId) {
  if (!sourceId) return '';
  return `EXISTS (SELECT 1 FROM ctx_ingest_source s WHERE s.source_id = ${lit(sourceId, 'uuid')} ` +
         `AND s.privacy_disposition IN ('clean','redacted'))`;
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
  // Privacy gate: when a source_id is given, the row is admitted only if that
  // source is mirror-eligible (clean/redacted) — otherwise SELECT yields no row
  // and nothing is written. No source_id => VALUES (caller is responsible for
  // gating; live wiring always supplies a gated source).
  const guard = _cleanSourceGuard(r.source_id);
  const body = guard
    ? `SELECT ${vals.join(', ')} WHERE ${guard}`
    : `VALUES (${vals.join(', ')})`;
  return (
    `INSERT INTO ctx_memory_artifact (${cols.join(', ')}) ${body} ` +
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
    const id = (res.stdout || '').trim() || undefined;
    // source_id present + no row back => the privacy gate withheld the write.
    if (!id && row.source_id) return { ok: true, gated: true };
    return { ok: true, id };
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

  // Privacy gate: when the observation carries a source_id, admit it only if
  // that source is mirror-eligible (clean/redacted).
  const guard = _cleanSourceGuard(r.source_id);

  if (r.artifact_id) {
    const allCols = ['artifact_id', ...cols];
    const allVals = [lit(r.artifact_id, 'uuid'), ...vals];
    const body = guard
      ? `SELECT ${allVals.join(', ')} WHERE ${guard}`
      : `VALUES (${allVals.join(', ')})`;
    return (
      `INSERT INTO ctx_memory_observation (${allCols.join(', ')}) ${body} ` +
      `ON CONFLICT (artifact_id, obs_hash) DO NOTHING RETURNING id;`
    );
  }
  // Resolve artifact_id from the natural key. If no artifact matches (or the
  // source is not mirror-eligible), the SELECT yields no rows and nothing is
  // inserted (best-effort no-op).
  const allCols = ['artifact_id', ...cols];
  const selVals = vals.join(', ');
  return (
    `INSERT INTO ctx_memory_observation (${allCols.join(', ')}) ` +
    `SELECT a.id${selVals ? ', ' + selVals : ''} FROM ctx_memory_artifact a ` +
    `WHERE a.bucket = ${lit(r.bucket, 'text')} AND a.source_file = ${lit(canonicalSourceFile(r.source_file), 'text')} AND a.row_id = ${lit(r.row_id, 'text')}` +
    (guard ? ` AND ${guard}` : '') + ' ' +
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

// ---- telemetry capture (Phase 3.5) -----------------------------------------
//
// Telemetry rows are token counts / costs / model ids — NOT content — so they
// are NOT privacy-gated here (the transcript-ingest slug blocklist already
// excludes private projects before they reach aggregation). source_id is still
// recorded for provenance/joins.

const MODEL_USAGE_FIELDS = {
  scope: 'text', session_id: 'uuid', agent_id: 'text', day: 'date', model_id: 'text',
  input_tokens: 'bigint', output_tokens: 'bigint', cache_read: 'bigint', cache_write: 'bigint',
  cost_usd: 'numeric', message_count: 'int', ts: 'timestamptz', source_id: 'uuid',
};
const SNAPSHOT_FIELDS = {
  scope: 'text', session_id: 'uuid', day: 'date', primary_model: 'text',
  wall_ms: 'bigint', api_duration_ms: 'bigint', tool_duration_ms: 'bigint',
  total_cost: 'numeric', input_tokens: 'bigint', output_tokens: 'bigint',
  cache_read: 'bigint', cache_write: 'bigint', message_count: 'int', tool_call_count: 'int',
  lines_added: 'int', lines_removed: 'int', failure_count: 'int', rejection_count: 'int',
  context_peak_pct: 'numeric', model_mix: 'jsonb', source_id: 'uuid',
};
const SUBAGENT_FIELDS = {
  agent_id: 'text', parent_session_id: 'uuid', agent_type: 'text', status: 'text',
  first_ts: 'timestamptz', last_ts: 'timestamptz', duration_ms: 'bigint',
  tool_call_count: 'int', total_cost: 'numeric', total_tokens: 'bigint',
  primary_model: 'text', source_id: 'uuid',
};

function _row(fields, obj) {
  const cols = Object.keys(fields).filter(c => obj[c] !== undefined);
  return { cols, vals: cols.map(c => lit(obj[c], fields[c])) };
}

// Build the atomic session-telemetry replace script: delete this session's
// prior session-scoped model_usage + snapshot, then insert the fresh set.
// Idempotent across re-ingests. Exported for shape tests.
function _buildSessionTelemetrySql({ session_id, source_id, day, modelUsage, snapshot }) {
  const sid = lit(session_id, 'uuid');
  const stmts = ['BEGIN;',
    `DELETE FROM ctx_model_usage WHERE scope = 'session' AND session_id = ${sid};`,
    `DELETE FROM ctx_telemetry_snapshot WHERE scope = 'session' AND session_id = ${sid};`];
  for (const mu of modelUsage || []) {
    const r = _row(MODEL_USAGE_FIELDS, { scope: 'session', session_id, model_id: mu.model_id,
      input_tokens: mu.input_tokens, output_tokens: mu.output_tokens, cache_read: mu.cache_read,
      cache_write: mu.cache_write, cost_usd: mu.cost_usd, message_count: mu.message_count,
      ts: snapshot && snapshot.last_ts, source_id });
    stmts.push(`INSERT INTO ctx_model_usage (${r.cols.join(', ')}) VALUES (${r.vals.join(', ')});`);
  }
  if (snapshot) {
    const r = _row(SNAPSHOT_FIELDS, { scope: 'session', session_id, day,
      primary_model: snapshot.primary_model, wall_ms: snapshot.wall_ms, total_cost: snapshot.total_cost,
      input_tokens: snapshot.input_tokens, output_tokens: snapshot.output_tokens,
      cache_read: snapshot.cache_read, cache_write: snapshot.cache_write,
      message_count: snapshot.message_count, tool_call_count: snapshot.tool_call_count,
      model_mix: snapshot.model_mix ? JSON.stringify(snapshot.model_mix) : undefined, source_id });
    stmts.push(`INSERT INTO ctx_telemetry_snapshot (${r.cols.join(', ')}) VALUES (${r.vals.join(', ')});`);
  }
  stmts.push('COMMIT;');
  return stmts.join('\n');
}

/**
 * Replace one session's telemetry (model_usage + snapshot) atomically. Never
 * throws; no-op when contextDb off. Idempotent — safe to re-run per ingest.
 * @param {{session_id:string, source_id?:string, day?:string, modelUsage:Array, snapshot:object}} t
 */
function writeSessionTelemetry(t) {
  try {
    if (!config.contextDb) return { ok: true, skipped: true };
    if (!t || !t.session_id) return { ok: false, error: 'writeSessionTelemetry: missing session_id' };
    if (!(t.modelUsage && t.modelUsage.length) && !t.snapshot) return { ok: true, skipped: true };
    const res = runSql(_buildSessionTelemetrySql(t));
    if (!res.ok) { appendOversightEvent('context_db_write_failed', { entity: 'ctx_telemetry(session)', session_id: t.session_id, error: res.error }); return res; }
    return { ok: true };
  } catch (e) {
    try { appendOversightEvent('context_db_write_failed', { entity: 'ctx_telemetry(session)', error: String(e.message || e) }); } catch {}
    return { ok: false, error: String(e.message || e) };
  }
}

function _buildSubagentRunSql(row) {
  const r = _row(SUBAGENT_FIELDS, row);
  const updatable = r.cols.filter(c => c !== 'agent_id');
  const setClause = updatable.map(c => `${c} = EXCLUDED.${c}`).join(', ');
  return (
    `INSERT INTO ctx_subagent_run (${r.cols.join(', ')}) VALUES (${r.vals.join(', ')}) ` +
    (setClause ? `ON CONFLICT (agent_id) DO UPDATE SET ${setClause}` : 'ON CONFLICT (agent_id) DO NOTHING') +
    `;`
  );
}

/**
 * Upsert one ctx_subagent_run (PK agent_id). Never throws; no-op when off.
 */
function upsertSubagentRun(row) {
  try {
    if (!config.contextDb) return { ok: true, skipped: true };
    if (!row || !row.agent_id) return { ok: false, error: 'upsertSubagentRun: missing agent_id' };
    const res = runSql(_buildSubagentRunSql(row));
    if (!res.ok) { appendOversightEvent('context_db_write_failed', { entity: 'ctx_subagent_run', agent_id: row.agent_id, error: res.error }); return res; }
    return { ok: true };
  } catch (e) {
    try { appendOversightEvent('context_db_write_failed', { entity: 'ctx_subagent_run', error: String(e.message || e) }); } catch {}
    return { ok: false, error: String(e.message || e) };
  }
}

module.exports = {
  upsertMemoryArtifact, insertMemoryObservation, logDualWrite,
  // privacy gate (Phase 3.4):
  upsertIngestSource, classifyDisposition, BLOCKLIST_VERSION,
  // telemetry capture (Phase 3.5):
  writeSessionTelemetry, upsertSubagentRun,
  sha256,
  // re-exported scribe-db plumbing (parity with scribe-db's surface):
  runSql, dollarQuote, canonicalSourceFile,
  // exported for shape tests (no live DB needed):
  _buildArtifactSql, _buildObservationSql, _buildDualWriteSql, _buildIngestSql, _cleanSourceGuard, lit,
  _buildSessionTelemetrySql, _buildSubagentRunSql,
};

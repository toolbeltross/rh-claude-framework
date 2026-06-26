/**
 * scribe-db.js — best-effort postgres shadow writes for scribe rows.
 * PLAN-2026-06-11-scribe-postgres-fts.md Phase 2.
 *
 * Design constraints:
 *  - Deployed scripts under ~/.claude/scripts/ have NO node_modules, so this
 *    module uses NO npm packages — it shells out to psql with pgpass auth
 *    (-w: never prompt). Connection params come from @rh/shared/config
 *    (scribeDb* keys; oversight.json overrides).
 *  - md files remain canonical. Every failure here is swallowed and logged
 *    as a scribe_db_write_failed oversight event; callers' md writes must
 *    never be blocked or failed by the DB shadow.
 *  - No-op (skipped:true) unless config.scribeDb is true.
 */

const fs = require('fs');
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const { config } = require('./config');

let appendOversightEvent = () => {};
try { ({ appendOversightEvent } = require('./oversight-events')); } catch { /* optional */ }

const PSQL_PROBES = [
  'C:/Program Files/PostgreSQL/18/bin/psql.exe',
  'C:/Program Files/PostgreSQL/17/bin/psql.exe',
  'C:/Program Files/PostgreSQL/16/bin/psql.exe',
  '/usr/bin/psql',
  '/usr/local/bin/psql',
];

let _psqlPath;
function findPsql() {
  if (_psqlPath !== undefined) return _psqlPath;
  if (config.scribeDbPsql) { _psqlPath = config.scribeDbPsql; return _psqlPath; }
  _psqlPath = PSQL_PROBES.find(p => { try { fs.accessSync(p); return true; } catch { return false; } }) || null;
  return _psqlPath;
}

/**
 * Canonicalize a source_file path to one spelling so the same logical file
 * is never recorded under multiple spellings (the parity audit flags
 * backslash-vs-forward-slash divergence as path_drift; confirmed live on
 * 2026-06-13 for Workspace/cleanup.md). Forward slashes, case preserved —
 * Windows is case-insensitive but the rest of the codebase uses forward
 * slashes, and lowercasing would corrupt case-sensitive POSIX paths.
 * Null/empty passes through unchanged.
 */
function canonicalSourceFile(p) {
  if (!p) return p;
  return String(p).replace(/\\/g, '/');
}

/**
 * Dollar-quote a string for safe literal embedding in SQL. Random tag,
 * re-rolled until absent from the payload, so no payload can escape.
 */
function dollarQuote(s) {
  let tag;
  do { tag = 'q' + crypto.randomBytes(4).toString('hex'); } while (String(s).includes('$' + tag + '$'));
  return '$' + tag + '$' + String(s) + '$' + tag + '$';
}

function runSql(sql, timeoutMs = 3000) {
  const psql = findPsql();
  if (!psql) return { ok: false, error: 'psql not found (set oversight.json scribeDbPsql)' };
  // SQL goes via stdin, NOT -c: on Windows, command-line args are encoded
  // with the system codepage (cp1252), silently mangling non-ASCII content
  // (verified 2026-06-11: a U+2192 arrow stored as '?'). stdin bytes are
  // ours; PGCLIENTENCODING=UTF8 stops psql from locale-guessing them.
  const res = spawnSync(psql, [
    '-U', config.scribeDbUser, '-h', config.scribeDbHost, '-p', String(config.scribeDbPort),
    '-d', config.scribeDbName, '-w', '-q', '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-f', '-',
  ], {
    timeout: timeoutMs, encoding: 'utf8', windowsHide: true,
    input: Buffer.from(sql, 'utf8'),
    env: { ...process.env, PGCLIENTENCODING: 'UTF8' },
  });
  if (res.error) return { ok: false, error: String(res.error.message || res.error) };
  if (res.status !== 0) return { ok: false, error: (res.stderr || '').slice(0, 300) };
  return { ok: true, stdout: (res.stdout || '').trim() };
}

/**
 * Upsert one scribe row into scribe_rows. Never throws.
 * @param {{bucket:string,row_id:string,session_id?:string,ts?:string,content:string,status?:string,source_file?:string,raw_line?:string}} row
 * @returns {{ok:boolean, skipped?:boolean, error?:string}}
 */
function writeRow(row) {
  try {
    if (!config.scribeDb) return { ok: true, skipped: true };
    const sourceFile = canonicalSourceFile(row.source_file);
    const tsLit = row.ts ? dollarQuote(row.ts) + '::timestamptz' : 'NULL';
    const sql =
      'INSERT INTO scribe_rows (bucket, row_id, session_id, ts, content, status, source_file, raw_line) VALUES (' +
      [
        dollarQuote(row.bucket),
        dollarQuote(row.row_id),
        row.session_id ? dollarQuote(row.session_id) : 'NULL',
        tsLit,
        dollarQuote(row.content || ''),
        row.status ? dollarQuote(row.status) : 'NULL',
        sourceFile ? dollarQuote(sourceFile) : 'NULL',
        row.raw_line ? dollarQuote(row.raw_line) : 'NULL',
      ].join(', ') +
      // Conflict key migrated 2026-06-13 to (bucket, source_file, row_id) so
      // per-project copies (same row_id, different file) no longer clobber each
      // other. source_file is canonicalized above; rows without a source_file
      // (NULL) simply never upsert-match, which is fine — scribe writers always
      // pass one. See PLAN-2026-06-13-context-db.md Phase 2.
      ') ON CONFLICT (bucket, source_file, row_id) DO UPDATE SET content = EXCLUDED.content, status = EXCLUDED.status, raw_line = EXCLUDED.raw_line, updated_at = now();';
    const res = runSql(sql);
    if (!res.ok) {
      appendOversightEvent('scribe_db_write_failed', { bucket: row.bucket, row_id: row.row_id, error: res.error });
    }
    return res;
  } catch (e) {
    try { appendOversightEvent('scribe_db_write_failed', { bucket: row && row.bucket, row_id: row && row.row_id, error: String(e.message || e) }); } catch {}
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * Read scribe rows as an array of objects. Never throws.
 * @param {{bucket?:string, status?:string, sourceFile?:string, limit?:number}} opts
 * @returns {{ok:boolean, rows?:object[], skipped?:boolean, error?:string}}
 *   skipped:true when scribeDb is off (caller should fall back to md-parse).
 */
function readRows(opts = {}) {
  try {
    if (!config.scribeDb) return { ok: true, skipped: true, rows: [] };
    const where = [];
    if (opts.bucket) where.push('bucket = ' + dollarQuote(opts.bucket));
    if (opts.status) where.push('status = ' + dollarQuote(opts.status));
    if (opts.sourceFile) where.push('source_file = ' + dollarQuote(canonicalSourceFile(opts.sourceFile)));
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const limitSql = Number.isInteger(opts.limit) && opts.limit > 0 ? 'LIMIT ' + opts.limit : '';
    // json_agg over a subquery → a single JSON blob on stdout, so row content
    // containing pipes/newlines never collides with psql's field/row delimiters.
    const sql =
      "SELECT coalesce(json_agg(row_to_json(t)), '[]'::json) FROM (" +
      'SELECT bucket, row_id, session_id, ts, content, status, source_file, ' +
      'proposed_disposition, proposed_rationale, proposed_followup, proposed_at ' +
      'FROM scribe_rows ' + whereSql + ' ORDER BY ts ASC NULLS FIRST ' + limitSql +
      ') t;';
    const res = runSql(sql);
    if (!res.ok) {
      appendOversightEvent('scribe_db_read_failed', { op: 'readRows', error: res.error });
      return { ok: false, error: res.error };
    }
    let rows;
    try { rows = JSON.parse(res.stdout || '[]'); } catch (e) {
      return { ok: false, error: 'unparseable json: ' + String(e.message || e) };
    }
    return { ok: true, rows: Array.isArray(rows) ? rows : [] };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * Write the LLM-proposed disposition columns for one row. Propose-only —
 * never touches `status`. Matches on the natural key (bucket, source_file,
 * row_id). Never throws.
 * @param {{bucket:string, source_file:string, row_id:string, disposition:string, rationale?:string, followup?:string}} p
 */
function setProposal(p) {
  try {
    if (!config.scribeDb) return { ok: true, skipped: true };
    const sql =
      'UPDATE scribe_rows SET ' +
      'proposed_disposition = ' + dollarQuote(p.disposition || '') + ', ' +
      'proposed_rationale = ' + (p.rationale ? dollarQuote(p.rationale) : 'NULL') + ', ' +
      'proposed_followup = ' + (p.followup ? dollarQuote(p.followup) : 'NULL') + ', ' +
      'proposed_at = now(), updated_at = now() ' +
      'WHERE bucket = ' + dollarQuote(p.bucket) +
      ' AND source_file = ' + dollarQuote(canonicalSourceFile(p.source_file)) +
      ' AND row_id = ' + dollarQuote(p.row_id) + ';';
    const res = runSql(sql);
    if (!res.ok) appendOversightEvent('scribe_db_write_failed', { op: 'setProposal', row_id: p.row_id, error: res.error });
    return res;
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * Update the canonical `status` of one row in the shadow. Called AFTER the
 * md write by rh-scribe-row-update.js; the md file stays canonical. Never
 * throws. Matches on (bucket, source_file, row_id).
 * @param {{bucket:string, source_file:string, row_id:string, status:string}} p
 */
function setStatus(p) {
  try {
    if (!config.scribeDb) return { ok: true, skipped: true };
    const sql =
      'UPDATE scribe_rows SET status = ' + dollarQuote(p.status) + ', updated_at = now() ' +
      'WHERE bucket = ' + dollarQuote(p.bucket) +
      ' AND source_file = ' + dollarQuote(canonicalSourceFile(p.source_file)) +
      ' AND row_id = ' + dollarQuote(p.row_id) + ';';
    const res = runSql(sql);
    if (!res.ok) appendOversightEvent('scribe_db_write_failed', { op: 'setStatus', row_id: p.row_id, error: res.error });
    return res;
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

module.exports = { writeRow, readRows, setProposal, setStatus, runSql, dollarQuote, findPsql, canonicalSourceFile };

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

module.exports = { writeRow, runSql, dollarQuote, findPsql, canonicalSourceFile };

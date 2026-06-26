/**
 * scribe-md.js — strict parser + status mutator for the tabular scribe md
 * files (cleanup.md / recommendations.md / learnings.md).
 *
 * md files are CANONICAL. The Postgres shadow (scribe-db.js) lags (dual-write
 * only since 2026-06-11, no backfill), so the disposition UI + triage driver
 * read the authoritative row set from here and use the DB only for proposal
 * overlay + status shadow. PLAN-2026-06-15-scribe-disposition-ui.
 *
 * Row schema (one line):  | id | ts | session | text | status |
 *  - id     : hex 8–16 chars
 *  - ts     : starts YYYY-MM-DD
 *  - text   : literal `|` is escaped as `\|`
 * Anything not matching (the `<!-- scribe-done -->` sentinel, prose, embedded
 * pipe-tables inside a text cell) is skipped — never counted as a row.
 *
 * NO npm deps (runs from ~/.claude/scripts/ post-install). NO config import —
 * callers pass absolute paths.
 */

const fs = require('fs');

const SENTINEL = '<!-- scribe-done -->';
// Split on pipes NOT preceded by a backslash, so escaped `\|` inside text
// cells stays intact (mirrors rh-learning-loop.js readOpenProposedFingerprints).
const UNESCAPED_PIPE = /(?<!\\)\|/;
const ID_RE = /^[a-f0-9]{8,16}$/;
const TS_RE = /^\d{4}-\d{2}-\d{2}/;

/** Parse one line into a row object, or null if it isn't a well-formed row. */
function parseLine(line) {
  if (!line || line[0] !== '|') return null;
  if (line.includes(SENTINEL)) return null;
  // 5 cells → split yields 7 parts: ["", c1..c5, ""].
  const parts = line.split(UNESCAPED_PIPE);
  if (parts.length !== 7) return null;
  const cells = parts.slice(1, 6).map(c => c.replace(/\\\|/g, '|').trim());
  const [id, ts, session, text, status] = cells;
  if (!ID_RE.test(id) || !TS_RE.test(ts)) return null;
  return { id, ts, session, text, status };
}

/** Parse a file's content → array of rows (each with its line index). */
function parseRows(content) {
  const out = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const r = parseLine(lines[i]);
    if (r) out.push({ ...r, lineIndex: i });
  }
  return out;
}

/** Read + parse a file. Returns { ok, rows, error }. Never throws. */
function readRows(filePath) {
  try {
    if (!fs.existsSync(filePath)) return { ok: true, rows: [] };
    return { ok: true, rows: parseRows(fs.readFileSync(filePath, 'utf8')) };
  } catch (e) {
    return { ok: false, rows: [], error: String(e.message || e) };
  }
}

function countSentinels(content) {
  return content.split(/\r?\n/).filter(l => l.trim() === SENTINEL).length;
}

/**
 * Replace ONE row's status cell, matched by id. Pure (operates on a string).
 * Steward conditions:
 *  - C2: matches exactly one row; 0 → "row not found", >1 → "ambiguous match".
 *  - C3: only the matched row line changes; sentinel count is preserved.
 * @returns {{ok:boolean, content?:string, oldStatus?:string, error?:string}}
 */
function replaceRowStatus(content, rowId, newStatus) {
  const lines = content.split(/\r?\n/);
  const matches = [];
  for (let i = 0; i < lines.length; i++) {
    const r = parseLine(lines[i]);
    if (r && r.id === rowId) matches.push(i);
  }
  if (matches.length === 0) return { ok: false, error: 'row not found' };
  if (matches.length > 1) return { ok: false, error: 'ambiguous match' };

  const idx = matches[0];
  const before = lines[idx];
  const parts = before.split(UNESCAPED_PIPE); // ["", c1..c5, ""]
  const oldStatus = parts[5].trim();
  parts[5] = ' ' + String(newStatus).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|') + ' ';
  lines[idx] = parts.join('|');

  const next = lines.join('\n');
  // C3 assertion: sentinel count unchanged.
  if (countSentinels(content) !== countSentinels(next)) {
    return { ok: false, error: 'sentinel-count changed — aborting' };
  }
  return { ok: true, content: next, oldStatus };
}

module.exports = { parseLine, parseRows, readRows, replaceRowStatus, countSentinels, SENTINEL };

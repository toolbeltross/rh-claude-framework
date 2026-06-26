#!/usr/bin/env node
/**
 * rh-scribe-parity-audit.js — Phase 4.1 of PLAN-2026-06-11-scribe-postgres-fts.
 *
 * Compares the canonical markdown scribe content against the postgres
 * `scribe_rows` shadow, per bucket, and reports drift. READ-ONLY: never
 * writes md or DB. This is the measurement tool the Phase 4.2 promotion
 * decision (md-canonical -> DB-primary) depends on; it does not itself
 * promote anything.
 *
 * Drift classes, per source file:
 *   matched  — id present in BOTH the md file and scribe_rows
 *   md_only  — id in md but NOT in the DB  (dual-write gap; expect a large
 *              count for rows written before dual-write began 2026-06-11)
 *   db_only  — row in the DB but NOT in md (md row deleted/edited away, or
 *              an orphaned/renamed source)
 *
 * Global warnings:
 *   path_drift     — one logical source file recorded under >1 spelling in
 *                    scribe_rows.source_file (e.g. backslash vs forward-slash)
 *   test_pollution — DB rows whose source_file is under an OS temp dir, i.e.
 *                    integration-test rows that leaked into the real database
 *
 * Mapping (must match the writers):
 *   recommendations / cleanup — one md table row (| id | ...) <-> one
 *     scribe_rows row keyed by row_id; source_file = the md file.
 *   learnings — only rh-learnings-write `create` dual-writes; row_id = the
 *     topic file basename (no .md); source_file = the topic file. append-
 *     observation / index updates do NOT dual-write, so observation-only
 *     changes never appear in the DB (not a drift bug).
 *
 * Usage:
 *   node rh-scribe-parity-audit.js [--bucket <name>] [--json] [--strict]
 * Exit 0 always, unless --strict and any drift/warning is found (then 1).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { config } = require('./lib/config');
const scribeDb = require('./lib/scribe-db');

const BUCKETS = ['recommendations', 'cleanup', 'learnings'];
// Tabular scribe row: | id | ts | session | text | status |  (id is hex 8-16)
const ID_RE = /^\|\s*([0-9a-f]{8,16})\s*\|/;

// ---- pure helpers (exported for tests) -------------------------------------

function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
}

function isTempPath(p) {
  const n = normalizePath(p);
  const tmp = normalizePath(os.tmpdir());
  if (tmp && n.startsWith(tmp)) return true;
  return /(^|\/)(temp|tmp)\//.test(n)
    || /appdata\/local\/temp\//.test(n)
    || /\/rh-lw-test-|\/rh-test-|\/rh-no-rule\.md$/.test(n);
}

// Parse pipe-separated psql output (-t -A) into row objects for the given cols.
function parsePsqlRows(stdout, cols) {
  if (!stdout || !stdout.trim()) return [];
  return stdout.split('\n').filter(l => l.length > 0).map(line => {
    const parts = line.split('|');
    const obj = {};
    cols.forEach((c, i) => { obj[c] = parts[i] !== undefined ? parts[i] : ''; });
    return obj;
  });
}

// Set difference + intersection sizes for two id sets.
function diffIdSets(mdSet, dbSet) {
  const md_only = [], db_only = [], matched = [];
  for (const id of mdSet) (dbSet.has(id) ? matched : md_only).push(id);
  for (const id of dbSet) if (!mdSet.has(id)) db_only.push(id);
  return { matched, md_only, db_only };
}

// Extract the id set from a tabular scribe md file. Returns null if missing.
function parseTableIds(filePath) {
  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); } catch { return null; }
  const ids = new Set();
  for (const line of content.split('\n')) {
    const m = line.match(ID_RE);
    if (m) ids.add(m[1]);
  }
  return ids;
}

// Topic-file basenames (sans .md) on disk in the learnings dir, minus indexes.
function learningsOnDisk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return null; }
  const set = new Set();
  for (const e of entries) {
    if (!e.endsWith('.md')) continue;
    if (e === 'MEMORY.md') continue;
    set.add(e.slice(0, -3));
  }
  return set;
}

// ---- DB access -------------------------------------------------------------

function queryBucketRows(bucket) {
  const res = scribeDb.runSql(
    `SELECT row_id, source_file, status FROM scribe_rows WHERE bucket = ${scribeDb.dollarQuote(bucket)} ORDER BY source_file, row_id;`
  );
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, rows: parsePsqlRows(res.stdout, ['row_id', 'source_file', 'status']) };
}

// ---- audit core ------------------------------------------------------------

// Group rows by normalized source_file; detect spelling drift + temp pollution.
// isTemp is injectable so unit tests can use temp-dir fixtures without them
// being treated as pollution (the real isTempPath is tested separately).
function groupBySource(rows, isTemp = isTempPath) {
  const groups = new Map(); // norm -> { spellings:Set, ids:Set, temp:bool }
  let tempCount = 0;
  for (const r of rows) {
    if (isTemp(r.source_file)) { tempCount++; continue; }
    const norm = normalizePath(r.source_file);
    if (!groups.has(norm)) groups.set(norm, { spellings: new Set(), ids: new Set(), temp: false });
    const g = groups.get(norm);
    g.spellings.add(r.source_file);
    g.ids.add(r.row_id);
  }
  const pathDrift = [...groups.entries()]
    .filter(([, g]) => g.spellings.size > 1)
    .map(([norm, g]) => ({ norm, spellings: [...g.spellings] }));
  return { groups, tempCount, pathDrift };
}

function auditTabularBucket(bucket, rows, extraFiles = [], isTemp = isTempPath) {
  const { groups, tempCount, pathDrift } = groupBySource(rows, isTemp);
  // Fold in canonical files even if they have zero DB rows (shows full gap).
  for (const f of extraFiles) {
    const norm = normalizePath(f);
    if (!groups.has(norm)) groups.set(norm, { spellings: new Set([f]), ids: new Set(), temp: false });
  }
  const files = [];
  let totMd = 0, totDb = 0, totMatched = 0, totMdOnly = 0, totDbOnly = 0;
  for (const [norm, g] of groups) {
    const repr = [...g.spellings][0] || norm;
    const mdSet = parseTableIds(repr);
    const missing = mdSet === null;
    const md = missing ? new Set() : mdSet;
    const { matched, md_only, db_only } = diffIdSets(md, g.ids);
    files.push({
      source: repr, missing,
      md: md.size, db: g.ids.size,
      matched: matched.length, md_only: md_only.length, db_only: db_only.length,
    });
    totMd += md.size; totDb += g.ids.size;
    totMatched += matched.length; totMdOnly += md_only.length; totDbOnly += db_only.length;
  }
  files.sort((a, b) => (b.md_only + b.db_only) - (a.md_only + a.db_only));
  return {
    bucket,
    totals: { md: totMd, db: totDb, matched: totMatched, md_only: totMdOnly, db_only: totDbOnly },
    files, pathDrift, tempCount,
  };
}

function auditLearnings(rows, dir, isTemp = isTempPath) {
  const { groups, tempCount, pathDrift } = groupBySource(rows, isTemp);
  const dbIds = new Set();
  for (const g of groups.values()) for (const id of g.ids) dbIds.add(id);
  const disk = learningsOnDisk(dir);
  const dirMissing = disk === null;
  const md = disk || new Set();
  const { matched, md_only, db_only } = diffIdSets(md, dbIds);
  return {
    bucket: 'learnings',
    totals: { md: md.size, db: dbIds.size, matched: matched.length, md_only: md_only.length, db_only: db_only.length },
    dir, dirMissing,
    md_only_samples: md_only.slice(0, 8),
    db_only_samples: db_only.slice(0, 8),
    pathDrift, tempCount,
  };
}

function runAudit(buckets) {
  const recCanonical = config.workspace ? path.join(config.workspace, 'recommendations.md') : null;
  const cleanCanonical = config.workspace ? path.join(config.workspace, 'cleanup.md') : null;
  const learningsDir = path.join(config.claudeDir, 'memory-shared', 'learnings');

  const out = { ok: true, results: [], errors: [] };
  for (const bucket of buckets) {
    const q = queryBucketRows(bucket);
    if (!q.ok) { out.ok = false; out.errors.push({ bucket, error: q.error }); continue; }
    if (bucket === 'learnings') {
      out.results.push(auditLearnings(q.rows, learningsDir));
    } else {
      const extra = bucket === 'recommendations' ? [recCanonical] : [cleanCanonical];
      out.results.push(auditTabularBucket(bucket, q.rows, extra.filter(Boolean)));
    }
  }
  return out;
}

// ---- reporting -------------------------------------------------------------

function hasDrift(audit) {
  return audit.results.some(r =>
    r.totals.md_only > 0 || r.totals.db_only > 0 || (r.pathDrift && r.pathDrift.length) || r.tempCount > 0
  ) || audit.errors.length > 0;
}

function renderText(audit) {
  const L = [];
  L.push('Scribe md ↔ postgres parity audit');
  L.push('='.repeat(60));
  for (const r of audit.results) {
    const t = r.totals;
    const parity = t.md === 0 ? 'n/a' : `${Math.round((t.matched / t.md) * 100)}%`;
    L.push('');
    L.push(`### ${r.bucket}`);
    L.push(`  md rows: ${t.md}  |  db rows: ${t.db}  |  matched: ${t.matched}  (${parity} of md mirrored)`);
    L.push(`  md_only (not in DB): ${t.md_only}   db_only (not in md): ${t.db_only}`);
    if (r.tempCount) L.push(`  ⚠ test_pollution: ${r.tempCount} DB row(s) under a temp dir (test leakage)`);
    if (r.pathDrift && r.pathDrift.length) {
      L.push(`  ⚠ path_drift: ${r.pathDrift.length} file(s) recorded under multiple spellings:`);
      for (const d of r.pathDrift) L.push(`      ${d.spellings.join('  ||  ')}`);
    }
    if (r.files) {
      for (const f of r.files) {
        const flag = f.missing ? ' [md file MISSING]' : '';
        L.push(`    - ${f.source}${flag}`);
        L.push(`        md ${f.md} / db ${f.db} → matched ${f.matched}, md_only ${f.md_only}, db_only ${f.db_only}`);
      }
    }
    if (r.bucket === 'learnings') {
      if (r.dirMissing) L.push(`  ⚠ learnings dir missing: ${r.dir}`);
      if (r.md_only_samples && r.md_only_samples.length) L.push(`    md_only e.g.: ${r.md_only_samples.join(', ')}`);
      if (r.db_only_samples && r.db_only_samples.length) L.push(`    db_only e.g.: ${r.db_only_samples.join(', ')}`);
    }
  }
  if (audit.errors.length) {
    L.push('');
    L.push('ERRORS:');
    for (const e of audit.errors) L.push(`  ${e.bucket}: ${e.error}`);
  }
  L.push('');
  L.push(hasDrift(audit) ? 'VERDICT: drift present — not promotion-ready (see md_only/db_only/warnings above).'
                         : 'VERDICT: clean parity.');
  return L.join('\n');
}

// ---- CLI -------------------------------------------------------------------

function parseArgs(argv) {
  const out = { bucket: null, json: false, strict: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--bucket') out.bucket = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--strict') out.strict = true;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!config.scribeDb) {
    console.error('scribeDb is OFF (config.scribeDb=false) — nothing to audit. Enable RH_SCRIBE_DB=1 or oversight.json scribeDb:true.');
    process.exit(0);
  }
  const buckets = args.bucket ? [args.bucket] : BUCKETS;
  for (const b of buckets) if (!BUCKETS.includes(b)) { console.error(`unknown bucket: ${b}`); process.exit(1); }

  const audit = runAudit(buckets);
  if (args.json) console.log(JSON.stringify(audit, null, 2));
  else console.log(renderText(audit));

  if (args.strict && hasDrift(audit)) process.exit(1);
  process.exit(0);
}

if (require.main === module) main();

module.exports = {
  normalizePath, isTempPath, parsePsqlRows, diffIdSets, parseTableIds,
  learningsOnDisk, groupBySource, auditTabularBucket, auditLearnings,
  hasDrift, renderText, parseArgs,
};

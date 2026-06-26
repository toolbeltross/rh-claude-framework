#!/usr/bin/env node
/**
 * rh-ingest-logs.js — incremental ingestion of oversight logs into the
 * rh_scribe postgres database for full-text search (log-FTS extension of
 * PLAN-2026-06-11-scribe-postgres-fts.md).
 *
 * Sources (all resolved via @rh/shared/config — no hardcoded user paths):
 *   supervisory-log    <oversightDir>/supervisory-log.md   (## heading-delimited entries)
 *   oversight-events   <claudeDir>/oversight-events.jsonl  (one JSON event per line)
 *   telemetry-failures <claudeDir>/telemetry-failures.jsonl
 *
 * Incremental per source via ingest_offsets (byte offset). If a file
 * SHRINKS (rewrite/rotation), that source is re-ingested from scratch
 * (DELETE + insert) — offsets only ever land on safe boundaries.
 *
 * Usage: node rh-ingest-logs.js [--dry-run] [--full] [--stats]
 * No-op unless config.scribeDb is true.
 */

const fs = require('fs');
const path = require('path');
const { config } = require('./lib/config');
const scribeDb = require('./lib/scribe-db');

const ARGS = process.argv.slice(2);
const DRY = ARGS.includes('--dry-run');
const FULL = ARGS.includes('--full');
const STATS = ARGS.includes('--stats');
const BATCH = 100;

/** supervisory-log.md → entries split on '## ' headings; preamble = seq 0. */
function parseSupervisoryMd(text) {
  const parts = text.split(/\n(?=## )/);
  return parts.map(p => {
    const m = p.match(/^## (\d{4}-\d{2}-\d{2})/);
    return { ts: m ? m[1] : null, content: p.trim() };
  }).filter(e => e.content);
}

/** JSONL → one entry per parseable line. */
function parseJsonl(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      const ts = j.timestamp || j.isoTime || j.ts || null;
      const tsStr = typeof ts === 'number' ? new Date(ts).toISOString() : ts;
      out.push({ ts: tsStr, content: line.length > 100000 ? line.slice(0, 100000) : line });
    } catch { /* skip unparseable line */ }
  }
  return out;
}

function sources() {
  return [
    { name: 'supervisory-log', file: config.oversightLogPath, parse: parseSupervisoryMd },
    { name: 'oversight-events', file: config.eventsLogPath, parse: parseJsonl },
    { name: 'telemetry-failures', file: path.join(config.claudeDir, 'telemetry-failures.jsonl'), parse: parseJsonl },
  ];
}

function ingestSource(src) {
  if (!fs.existsSync(src.file)) return { source: src.name, skipped: 'file absent' };
  const size = fs.statSync(src.file).size;

  const prev = scribeDb.runSql(
    `SELECT ingested_through || '|' || entries FROM ingest_offsets WHERE source=${scribeDb.dollarQuote(src.name)};`);
  if (!prev.ok) return { source: src.name, error: prev.error };
  let offset = 0, seq = 0;
  if (prev.stdout && !FULL) {
    const [o, e] = prev.stdout.split('|');
    offset = parseInt(o, 10) || 0; seq = parseInt(e, 10) || 0;
  }
  const shrunk = offset > size;
  if (shrunk || FULL) { offset = 0; seq = 0; }
  if (offset >= size) return { source: src.name, upToDate: true };

  const buf = fs.readFileSync(src.file);
  // For the md source, '## '-boundary splitting needs the whole file when
  // starting fresh; for appends, the tail chunk alone is safe for BOTH
  // formats only when offset sits at a line boundary (it always does — we
  // record full-file sizes). A tail chunk starting mid-entry of the md log
  // would mis-split, so the md source always re-reads from 0 when offset>0
  // changed... simpler + correct: md re-ingests fully whenever it grew.
  let entries;
  if (src.parse === parseSupervisoryMd && offset > 0) {
    offset = 0; seq = 0; // full re-parse; replace rows below
  }
  entries = src.parse(buf.slice(offset).toString('utf8'));

  if (DRY) return { source: src.name, wouldIngest: entries.length, fromOffset: offset };

  if (offset === 0 && (seq === 0)) {
    const del = scribeDb.runSql(`DELETE FROM log_entries WHERE source=${scribeDb.dollarQuote(src.name)};`, 30000);
    if (!del.ok) return { source: src.name, error: del.error };
  }

  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = entries.slice(i, i + BATCH);
    const values = batch.map((e, k) => '(' + [
      scribeDb.dollarQuote(src.name),
      String(seq + i + k),
      e.ts ? scribeDb.dollarQuote(e.ts) + '::timestamptz' : 'NULL',
      scribeDb.dollarQuote(e.content),
    ].join(',') + ')').join(',\n');
    const res = scribeDb.runSql(
      `INSERT INTO log_entries (source, seq, ts, content) VALUES\n${values}\nON CONFLICT (source, seq) DO NOTHING;`, 60000);
    if (!res.ok) return { source: src.name, error: res.error, partialAt: seq + i };
  }

  const up = scribeDb.runSql(
    `INSERT INTO ingest_offsets (source, ingested_through, entries) VALUES (${scribeDb.dollarQuote(src.name)}, ${size}, ${seq + entries.length})
     ON CONFLICT (source) DO UPDATE SET ingested_through=${size}, entries=${seq + entries.length}, ingested_at=now();`);
  if (!up.ok) return { source: src.name, error: up.error };
  return { source: src.name, ingested: entries.length };
}

function main() {
  if (STATS) {
    const r = scribeDb.runSql("SELECT source || ': ' || count(*) FROM log_entries GROUP BY source ORDER BY source;");
    console.log(r.ok ? (r.stdout || '(empty)') : `error: ${r.error}`);
    return;
  }
  if (!config.scribeDb) { console.log('scribeDb flag off — nothing to do.'); return; }
  const results = sources().map(ingestSource);
  console.log(JSON.stringify(results, null, 1));
  if (results.some(r => r.error)) process.exitCode = 1;
}

if (require.main === module) main();
module.exports = { parseSupervisoryMd, parseJsonl };

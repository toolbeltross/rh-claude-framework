#!/usr/bin/env node
/**
 * rh-transcript-ingest.js — incremental Claude Code transcript ingestion
 * into the rh_scribe postgres database for full-text search.
 * PLAN-2026-06-11-scribe-postgres-fts.md Phase 3.
 *
 * Scans <claudeDir>/projects/<slug>/<session>.jsonl, extracts user/assistant
 * TEXT messages (tool blobs skipped), and bulk-inserts into
 * transcript_messages. Incremental: transcripts.ingested_through stores the
 * byte offset already processed per session; re-runs resume from there
 * (offsets always land on line boundaries because we record the full file
 * size after a complete pass).
 *
 * Privacy: project slugs matching ~/.claude/private-blocklist.json patterns
 * (path-scoped, '/'→'-' normalized) or the framework's built-in Personal- /
 * Financial- markers are skipped and counted, never ingested. The DB is
 * local-only and sits in the same trust domain as the transcript files
 * themselves.
 *
 * Usage:
 *   node rh-transcript-ingest.js [--dry-run] [--full] [--project <slug>] [--stats]
 *     --dry-run  list what would be ingested, write nothing
 *     --full     forget offsets and re-ingest everything (delete + reinsert)
 *     --project  restrict to one project slug
 *     --stats    print DB counts and exit
 *
 * No-op (exit 0, message) unless config.scribeDb is true.
 */

const fs = require('fs');
const path = require('path');
const { config } = require('./lib/config');
const scribeDb = require('./lib/scribe-db');

const ARGS = process.argv.slice(2);
const DRY = ARGS.includes('--dry-run');
const FULL = ARGS.includes('--full');
const STATS = ARGS.includes('--stats');
const ONLY_PROJECT = ARGS.includes('--project') ? ARGS[ARGS.indexOf('--project') + 1] : null;

const BATCH_ROWS = 200;          // rows per INSERT statement
const MAX_MSG_CHARS = 500000;    // clamp pathological messages

function loadBlockPatterns() {
  const builtin = ['personal-', 'financial-'];
  try {
    const j = JSON.parse(fs.readFileSync(path.join(config.claudeDir, 'private-blocklist.json'), 'utf8'));
    const fromFile = (j.patterns || []).map(p => String(p).replace(/[\\/]+/g, '-').toLowerCase());
    return builtin.concat(fromFile);
  } catch { return builtin; }
}

function slugBlocked(slug, patterns) {
  const s = ('-' + slug + '-').toLowerCase();
  return patterns.some(p => s.includes('-' + p.replace(/^-+|-+$/g, '') + '-') || s.includes(p));
}

/** Extract plain text from a transcript JSONL line; null if not a text message. */
function extractMessage(line) {
  let j;
  try { j = JSON.parse(line); } catch { return null; }
  if (j.type !== 'user' && j.type !== 'assistant') return null;
  const msg = j.message;
  if (!msg) return null;
  let text = '';
  if (typeof msg.content === 'string') text = msg.content;
  else if (Array.isArray(msg.content)) {
    text = msg.content.filter(b => b && b.type === 'text' && b.text).map(b => b.text).join('\n');
  }
  text = text.trim();
  if (!text) return null;
  return { role: j.type, ts: j.timestamp || null, text: text.slice(0, MAX_MSG_CHARS) };
}

function sqlBatchInsert(sessionId, startTurn, msgs) {
  const values = msgs.map((m, i) => '(' + [
    scribeDb.dollarQuote(sessionId),
    String(startTurn + i),
    scribeDb.dollarQuote(m.role),
    m.ts ? scribeDb.dollarQuote(m.ts) + '::timestamptz' : 'NULL',
    scribeDb.dollarQuote(m.text),
  ].join(',') + ')').join(',\n');
  return `INSERT INTO transcript_messages (session_id, turn, role, ts, content) VALUES\n${values};`;
}

function ingestFile(slug, file) {
  const sessionId = path.basename(file, '.jsonl');
  const size = fs.statSync(file).size;

  const prev = scribeDb.runSql(
    `SELECT ingested_through || '|' || message_count FROM transcripts WHERE session_id=${scribeDb.dollarQuote(sessionId)};`
  );
  if (!prev.ok) return { sessionId, error: prev.error };
  let offset = 0, turn = 0;
  if (prev.stdout) {
    const [o, c] = prev.stdout.split('|');
    offset = FULL ? 0 : parseInt(o, 10) || 0;
    turn = FULL ? 0 : parseInt(c, 10) || 0;
  }
  if (offset >= size) return { sessionId, skipped: 'up-to-date' };

  const buf = fs.readFileSync(file);
  const chunk = buf.slice(offset).toString('utf8');
  const msgs = [];
  for (const line of chunk.split('\n')) {
    const m = extractMessage(line);
    if (m) msgs.push(m);
  }

  if (DRY) return { sessionId, wouldIngest: msgs.length, fromOffset: offset };

  // Upsert transcript header first (FK target), reset on --full.
  const tsFirst = msgs.length && msgs[0].ts ? scribeDb.dollarQuote(msgs[0].ts) + '::timestamptz' : 'NULL';
  const tsLast = msgs.length && msgs[msgs.length - 1].ts ? scribeDb.dollarQuote(msgs[msgs.length - 1].ts) + '::timestamptz' : 'NULL';
  const header = (FULL && prev.stdout
    ? `DELETE FROM transcript_messages WHERE session_id=${scribeDb.dollarQuote(sessionId)};\n`
    : '') +
    `INSERT INTO transcripts (session_id, project_slug, path, first_ts, last_ts, message_count, ingested_through)
     VALUES (${scribeDb.dollarQuote(sessionId)}, ${scribeDb.dollarQuote(slug)}, ${scribeDb.dollarQuote(file)}, ${tsFirst}, ${tsLast}, 0, 0)
     ON CONFLICT (session_id) DO UPDATE SET last_ts = COALESCE(EXCLUDED.last_ts, transcripts.last_ts)${FULL ? ', message_count = 0, ingested_through = 0' : ''};`;
  let res = scribeDb.runSql(header, 10000);
  if (!res.ok) return { sessionId, error: res.error };

  for (let i = 0; i < msgs.length; i += BATCH_ROWS) {
    const batch = msgs.slice(i, i + BATCH_ROWS);
    res = scribeDb.runSql(sqlBatchInsert(sessionId, turn + i, batch), 60000);
    if (!res.ok) return { sessionId, error: res.error, partialAt: turn + i };
  }

  res = scribeDb.runSql(
    `UPDATE transcripts SET ingested_through=${size}, message_count=${turn + msgs.length}, ingested_at=now() WHERE session_id=${scribeDb.dollarQuote(sessionId)};`
  );
  if (!res.ok) return { sessionId, error: res.error };
  return { sessionId, ingested: msgs.length };
}

function main() {
  if (STATS) {
    const r = scribeDb.runSql("SELECT (SELECT count(*) FROM transcripts) || ' transcripts, ' || (SELECT count(*) FROM transcript_messages) || ' messages';");
    console.log(r.ok ? r.stdout : `error: ${r.error}`);
    return;
  }
  if (!config.scribeDb) {
    console.log('scribeDb flag is off (oversight.json scribeDb:true to enable) — nothing to do.');
    return;
  }
  const projectsDir = path.join(config.claudeDir, 'projects');
  if (!fs.existsSync(projectsDir)) { console.log('no projects dir'); return; }

  const patterns = loadBlockPatterns();
  const summary = { projects: 0, files: 0, ingested: 0, upToDate: 0, blockedProjects: 0, errors: [] };

  for (const slug of fs.readdirSync(projectsDir)) {
    const dir = path.join(projectsDir, slug);
    if (!fs.statSync(dir).isDirectory()) continue;
    if (ONLY_PROJECT && slug !== ONLY_PROJECT) continue;
    if (slugBlocked(slug, patterns)) { summary.blockedProjects++; continue; }
    summary.projects++;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      summary.files++;
      const r = ingestFile(slug, path.join(dir, f));
      if (r.error) summary.errors.push(`${r.sessionId}: ${r.error}`);
      else if (r.skipped) summary.upToDate++;
      else summary.ingested += r.ingested || r.wouldIngest || 0;
    }
  }
  console.log(JSON.stringify({ dryRun: DRY || undefined, ...summary, errors: summary.errors.slice(0, 5) }, null, 1));
  if (summary.errors.length) process.exitCode = 1;
}

if (require.main === module) main();
module.exports = { extractMessage, slugBlocked, loadBlockPatterns, sqlBatchInsert };

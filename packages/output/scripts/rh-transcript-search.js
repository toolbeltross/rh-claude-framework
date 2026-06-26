#!/usr/bin/env node
/**
 * rh-transcript-search.js — full-text search over ingested Claude Code
 * transcripts and oversight logs. PLAN-2026-06-11-scribe-postgres-fts.md
 * Phase 3 (+ log-FTS extension).
 *
 * Usage:
 *   node rh-transcript-search.js "query terms" [--project <slug-substring>]
 *                                [--days N] [--limit N] [--role user|assistant]
 *                                [--logs | --all]
 *     --logs  search log_entries (supervisory log, oversight events,
 *             telemetry failures) instead of transcripts
 *     --all   search both corpora (results labeled by origin)
 *
 * Query syntax = postgres websearch_to_tsquery: bare words AND'd,
 * "quoted phrases", OR, -negation.
 */

const { config } = require('./lib/config');
const scribeDb = require('./lib/scribe-db');

function parseArgs(argv) {
  const out = { terms: [], project: null, days: null, limit: 10, role: null, corpus: 'transcripts' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') out.project = argv[++i];
    else if (a === '--days') out.days = parseInt(argv[++i], 10);
    else if (a === '--limit') out.limit = Math.min(parseInt(argv[++i], 10) || 10, 100);
    else if (a === '--role') out.role = argv[++i];
    else if (a === '--logs') out.corpus = 'logs';
    else if (a === '--all') out.corpus = 'all';
    else out.terms.push(a);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const query = args.terms.join(' ').trim();
  if (!query) {
    console.error('usage: rh-transcript-search "query terms" [--project slug] [--days N] [--limit N] [--role user|assistant] [--logs|--all]');
    process.exit(1);
  }
  const q = scribeDb.dollarQuote(query);
  const headline = (col) =>
    `replace(ts_headline('english', left(${col}, 8000), websearch_to_tsquery('english', ${q}), ` +
    `'MaxWords=18, MinWords=8, StartSel=>>, StopSel=<<'), E'\\n', ' ')`;

  const tWhere = [`m.content_tsv @@ websearch_to_tsquery('english', ${q})`];
  if (args.project) tWhere.push(`t.project_slug ILIKE ${scribeDb.dollarQuote('%' + args.project + '%')}`);
  if (args.days) tWhere.push(`m.ts > now() - interval '${args.days} days'`);
  if (args.role === 'user' || args.role === 'assistant') tWhere.push(`m.role = '${args.role}'`);
  const tQuery = `
SELECT m.session_id, t.project_slug, m.role,
  to_char(m.ts, 'YYYY-MM-DD HH24:MI') AS at,
  round(ts_rank(m.content_tsv, websearch_to_tsquery('english', ${q}))::numeric, 4) AS rank,
  ${headline('m.content')} AS snippet
FROM transcript_messages m
JOIN transcripts t USING (session_id)
WHERE ${tWhere.join(' AND ')}`;

  const lWhere = [`l.content_tsv @@ websearch_to_tsquery('english', ${q})`];
  if (args.days) lWhere.push(`l.ts > now() - interval '${args.days} days'`);
  const lQuery = `
SELECT l.source AS session_id, '(log)' AS project_slug, l.source AS role,
  to_char(l.ts, 'YYYY-MM-DD HH24:MI') AS at,
  round(ts_rank(l.content_tsv, websearch_to_tsquery('english', ${q}))::numeric, 4) AS rank,
  ${headline('l.content')} AS snippet
FROM log_entries l
WHERE ${lWhere.join(' AND ')}`;

  const body = args.corpus === 'logs' ? lQuery
    : args.corpus === 'all' ? `(${tQuery}) UNION ALL (${lQuery})`
    : tQuery;
  const sql = `${body}
ORDER BY rank DESC, at DESC NULLS LAST
LIMIT ${args.limit};`;

  const res = scribeDb.runSql(sql, 30000);
  if (!res.ok) { console.error(`search failed: ${res.error}`); process.exit(1); }
  if (!res.stdout) { console.log(`no hits for: ${query}`); return; }

  for (const line of res.stdout.split('\n')) {
    const [sess, slug, role, at, rank, ...rest] = line.split('|');
    const shortSlug = (slug || '').replace(/^C--Users-[^-]+-/, '').slice(0, 40);
    console.log(`${(at || 'undated').padEnd(16)} ${sess.slice(0, 18).padEnd(18)} ${role.padEnd(18)} ${shortSlug}`);
    console.log(`  ${rest.join('|')}`);
  }
}

main();

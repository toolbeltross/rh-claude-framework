#!/usr/bin/env node
/**
 * rh-transcript-search.js — full-text search over ingested Claude Code
 * transcripts. PLAN-2026-06-11-scribe-postgres-fts.md Phase 3.
 *
 * Usage:
 *   node rh-transcript-search.js "query terms" [--project <slug-substring>]
 *                                [--days N] [--limit N] [--role user|assistant]
 *
 * Query syntax = postgres websearch_to_tsquery: bare words AND'd,
 * "quoted phrases", OR, -negation.
 */

const { config } = require('./lib/config');
const scribeDb = require('./lib/scribe-db');

function parseArgs(argv) {
  const out = { terms: [], project: null, days: null, limit: 10, role: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') out.project = argv[++i];
    else if (a === '--days') out.days = parseInt(argv[++i], 10);
    else if (a === '--limit') out.limit = Math.min(parseInt(argv[++i], 10) || 10, 100);
    else if (a === '--role') out.role = argv[++i];
    else out.terms.push(a);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const query = args.terms.join(' ').trim();
  if (!query) {
    console.error('usage: rh-transcript-search "query terms" [--project slug] [--days N] [--limit N] [--role user|assistant]');
    process.exit(1);
  }
  const q = scribeDb.dollarQuote(query);
  const where = [`m.content_tsv @@ websearch_to_tsquery('english', ${q})`];
  if (args.project) where.push(`t.project_slug ILIKE ${scribeDb.dollarQuote('%' + args.project + '%')}`);
  if (args.days) where.push(`m.ts > now() - interval '${args.days} days'`);
  if (args.role === 'user' || args.role === 'assistant') where.push(`m.role = '${args.role}'`);

  const sql = `
SELECT
  m.session_id, t.project_slug, m.role,
  to_char(m.ts, 'YYYY-MM-DD HH24:MI') AS at,
  round(ts_rank(m.content_tsv, websearch_to_tsquery('english', ${q}))::numeric, 4) AS rank,
  replace(ts_headline('english', left(m.content, 8000), websearch_to_tsquery('english', ${q}),
    'MaxWords=18, MinWords=8, StartSel=>>, StopSel=<<'), E'\\n', ' ') AS snippet
FROM transcript_messages m
JOIN transcripts t USING (session_id)
WHERE ${where.join(' AND ')}
ORDER BY rank DESC, m.ts DESC NULLS LAST
LIMIT ${args.limit};`;

  const res = scribeDb.runSql(sql, 30000);
  if (!res.ok) { console.error(`search failed: ${res.error}`); process.exit(1); }
  if (!res.stdout) { console.log(`no hits for: ${query}`); return; }

  for (const line of res.stdout.split('\n')) {
    const [sess, slug, role, at, rank, ...rest] = line.split('|');
    const shortSlug = (slug || '').replace(/^C--Users-[^-]+-/, '').slice(0, 40);
    console.log(`${(at || 'undated').padEnd(16)} ${sess.slice(0, 8)}  ${role.padEnd(9)} ${shortSlug}`);
    console.log(`  ${rest.join('|')}`);
  }
}

main();

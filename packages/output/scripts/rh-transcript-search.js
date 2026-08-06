#!/usr/bin/env node
/**
 * rh-transcript-search.js — full-text search over ingested Claude Code
 * transcripts and oversight logs. PLAN-2026-06-11-scribe-postgres-fts.md
 * Phase 3 (+ log-FTS extension).
 *
 * Usage:
 *   node rh-transcript-search.js "query terms" [--project <slug-substring>]
 *                                [--days N] [--limit N] [--role user|assistant]
 *                                [--logs | --all] [--literal]
 *     --logs     search log_entries (supervisory log, oversight events,
 *                telemetry failures) instead of transcripts
 *     --all      search both corpora (results labeled by origin)
 *     --literal  exact substring match (ILIKE), bypassing FTS. Use for paths,
 *                filenames and hyphenated identifiers, which Postgres indexes
 *                as single atomic tokens and which FTS therefore cannot match.
 *
 * Query syntax = postgres websearch_to_tsquery: bare words AND'd,
 * "quoted phrases", OR, -negation.
 *
 * A query containing separators that returns zero FTS hits is retried once with
 * those separators split to spaces, and the relaxation is reported (never silent).
 */

const { config } = require('./lib/config');
const scribeDb = require('./lib/scribe-db');

function parseArgs(argv) {
  const out = { terms: [], project: null, days: null, limit: 10, role: null, corpus: 'transcripts', literal: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') out.project = argv[++i];
    else if (a === '--days') out.days = parseInt(argv[++i], 10);
    else if (a === '--limit') out.limit = Math.min(parseInt(argv[++i], 10) || 10, 100);
    else if (a === '--role') out.role = argv[++i];
    else if (a === '--logs') out.corpus = 'logs';
    else if (a === '--all') out.corpus = 'all';
    else if (a === '--literal') out.literal = true;
    else out.terms.push(a);
  }
  return out;
}

// ─── Identifier-shaped queries (2026-08-02) ──────────────────────────────────
// Postgres indexes a path/filename/URL as ONE atomic lexeme: to_tsvector on
// '~/.claude/memory-mcp-graph.json' yields '/.claude/memory-mcp-graph.json' and never the
// parts memory/mcp/graph. Separately, websearch_to_tsquery expands a hyphenated term into an
// ADJACENCY phrase ('memory-mcp-graph' <-> 'memori' <-> 'mcp' <-> 'graph') that the atomic
// token can never satisfy. Net effect: searching any identifier silently returns zero rows
// even when the literal string is present — the worst failure shape for a search tool, and
// one already misread as "the index is stale". Two mitigations below:
//   --literal    exact substring match (ILIKE), bypasses FTS entirely
//   auto-relax   on zero FTS hits, retry once with separators split to spaces, clearly labeled
const SEPARATORS = /[-._/\\:]+/g;
const looksLikeIdentifier = (s) => SEPARATORS.test(s);
const relaxQuery = (s) => s.replace(SEPARATORS, ' ').replace(/\s+/g, ' ').trim();

function buildSql(args, queryStr) {
  const q = scribeDb.dollarQuote(queryStr);
  const likeQ = scribeDb.dollarQuote('%' + queryStr + '%');

  // Literal mode: ILIKE + a window around the match (ts_headline needs a tsquery).
  const match = (col) => args.literal
    ? `${col} ILIKE ${likeQ}`
    : `${col}_tsv @@ websearch_to_tsquery('english', ${q})`;
  const rank = (col) => args.literal
    ? `0::numeric`
    : `round(ts_rank(${col}_tsv, websearch_to_tsquery('english', ${q}))::numeric, 4)`;
  const snippet = (col) => args.literal
    ? `replace(substr(${col}, greatest(1, position(${q} in ${col}) - 60), 220), E'\\n', ' ')`
    : `replace(ts_headline('english', left(${col}, 8000), websearch_to_tsquery('english', ${q}), ` +
      `'MaxWords=18, MinWords=8, StartSel=>>, StopSel=<<'), E'\\n', ' ')`;

  const tWhere = [match('m.content')];
  if (args.project) tWhere.push(`t.project_slug ILIKE ${scribeDb.dollarQuote('%' + args.project + '%')}`);
  if (args.days) tWhere.push(`m.ts > now() - interval '${args.days} days'`);
  if (args.role === 'user' || args.role === 'assistant') tWhere.push(`m.role = '${args.role}'`);
  const tQuery = `
SELECT m.session_id, t.project_slug, m.role,
  to_char(m.ts, 'YYYY-MM-DD HH24:MI') AS at,
  ${rank('m.content')} AS rank,
  ${snippet('m.content')} AS snippet
FROM transcript_messages m
JOIN transcripts t USING (session_id)
WHERE ${tWhere.join(' AND ')}`;

  const lWhere = [match('l.content')];
  if (args.days) lWhere.push(`l.ts > now() - interval '${args.days} days'`);
  const lQuery = `
SELECT l.source AS session_id, '(log)' AS project_slug, l.source AS role,
  to_char(l.ts, 'YYYY-MM-DD HH24:MI') AS at,
  ${rank('l.content')} AS rank,
  ${snippet('l.content')} AS snippet
FROM log_entries l
WHERE ${lWhere.join(' AND ')}`;

  const body = args.corpus === 'logs' ? lQuery
    : args.corpus === 'all' ? `(${tQuery}) UNION ALL (${lQuery})`
    : tQuery;
  return `${body}
ORDER BY rank DESC, at DESC NULLS LAST
LIMIT ${args.limit};`;
}

function printRows(stdout) {
  for (const line of stdout.split('\n')) {
    const [sess, slug, role, at, rank, ...rest] = line.split('|');
    const shortSlug = (slug || '').replace(/^C--Users-[^-]+-/, '').slice(0, 40);
    console.log(`${(at || 'undated').padEnd(16)} ${sess.slice(0, 18).padEnd(18)} ${role.padEnd(18)} ${shortSlug}`);
    console.log(`  ${rest.join('|')}`);
  }
}

function runSearch(args, queryStr) {
  const res = scribeDb.runSql(buildSql(args, queryStr), 30000);
  if (!res.ok) { console.error(`search failed: ${res.error}`); process.exit(1); }
  return res;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const query = args.terms.join(' ').trim();
  if (!query) {
    console.error('usage: rh-transcript-search "query terms" [--project slug] [--days N] [--limit N] [--role user|assistant] [--logs|--all] [--literal]');
    process.exit(1);
  }

  let res = runSearch(args, query);
  if (res.stdout) { printRows(res.stdout); return; }

  // Auto-relax: an identifier-shaped query that found nothing is usually the atomic-token
  // trap, not an empty corpus. Retry once with separators split, and SAY SO — a silent
  // rewrite would be its own trap.
  if (!args.literal && looksLikeIdentifier(query)) {
    const relaxed = relaxQuery(query);
    if (relaxed && relaxed !== query) {
      res = runSearch(args, relaxed);
      if (res.stdout) {
        console.log(`no exact hits for "${query}" — relaxed to "${relaxed}" (separators split; Postgres indexes paths/identifiers as single tokens):\n`);
        printRows(res.stdout);
        return;
      }
    }
    console.log(`no hits for: ${query}\n  (tried relaxed form too. For an exact substring match, re-run with --literal)`);
    return;
  }
  console.log(`no hits for: ${query}`);
}

main();

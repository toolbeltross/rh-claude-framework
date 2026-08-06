#!/usr/bin/env node
/**
 * rh-recall.js — one query across every memory store, so prior work is reachable instead of
 * re-derived. Backs the `/rh-recall` skill.
 *
 * Searches: transcripts, oversight logs, scribe rows (WITH their LLM proposals), shared
 * learnings, per-project memory, and the MCP knowledge graph.
 *
 * Design notes:
 *  - All store access goes through lib/recall-sources.js. `scribe_rows` is a standing
 *    deletion candidate; nothing here may depend on its shape.
 *  - Postgres-backed stores degrade to empty on machines without it (or without the
 *    oversight system). The .md files are the system of record and always work. Degraded
 *    stores are REPORTED, never silently skipped — a quiet empty result reads as
 *    "nothing to find" and would recreate the exact failure this tool exists to fix.
 *
 * Usage:
 *   node rh-recall.js "query terms" [--limit N] [--days N] [--source s1,s2] [--json]
 */
const R = require('./lib/recall-sources');

function parseArgs(argv) {
  const o = { terms: [], limit: 6, days: null, sources: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') o.limit = Math.max(1, Math.min(parseInt(argv[++i], 10) || 6, 40));
    else if (a === '--days') o.days = parseInt(argv[++i], 10) || null;
    else if (a === '--source') o.sources = String(argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--json') o.json = true;
    else o.terms.push(a);
  }
  return o;
}

const SOURCES = [
  { key: 'graph', label: 'Concept graph', fn: (q, o) => R.searchGraph(q, o) },
  { key: 'memory', label: 'Project memory', fn: (q, o) => R.searchProjectMemory(q, o) },
  { key: 'learnings', label: 'Shared learnings', fn: (q, o) => R.searchLearnings(q, o) },
  { key: 'scribe', label: 'Scribe rows + proposals', fn: (q, o) => R.searchScribe(q, o) },
  { key: 'transcripts', label: 'Past session transcripts', fn: (q, o) => R.searchTranscripts(q, o) },
  { key: 'logs', label: 'Oversight logs', fn: (q, o) => R.searchLogs(q, o) },
];

function main() {
  const args = parseArgs(process.argv.slice(2));
  const query = args.terms.join(' ').trim();
  if (!query) {
    console.error('usage: rh-recall "query terms" [--limit N] [--days N] [--source graph,learnings,...] [--json]');
    console.error('sources: ' + SOURCES.map(s => s.key).join(', '));
    process.exit(1);
  }

  const avail = R.available();
  const picked = args.sources ? SOURCES.filter(s => args.sources.includes(s.key)) : SOURCES;

  const results = {};
  for (const s of picked) {
    try { results[s.key] = s.fn(query, { limit: args.limit, days: args.days }) || []; }
    catch { results[s.key] = []; }
  }

  if (args.json) {
    console.log(JSON.stringify({ query, available: avail, results }, null, 1));
    return;
  }

  const total = Object.values(results).reduce((n, r) => n + r.length, 0);
  console.log(`RECALL "${query}" — ${total} hit${total === 1 ? '' : 's'}`);

  // Report degradation explicitly; a silent empty section is indistinguishable from
  // "searched and found nothing", which is the failure mode this tool exists to prevent.
  const degraded = [];
  if (!avail.postgres) degraded.push('Postgres unavailable → transcripts, logs and scribe rows NOT searched');
  if (!avail.graph) degraded.push('no knowledge graph on this machine → concept links NOT searched');
  if (!avail.learnings) degraded.push('no shared learnings dir');
  if (degraded.length) {
    console.log('\n  ⚠ degraded on this machine:');
    degraded.forEach(d => console.log('    - ' + d));
  }

  for (const s of picked) {
    const rows = results[s.key];
    if (!rows.length) continue;
    console.log(`\n── ${s.label} (${rows.length})`);
    for (const r of rows.sort((a, b) => b.score - a.score)) {
      const when = r.ts ? String(r.ts).slice(0, 10) : '          ';
      console.log(`  ${when}  ${r.title}`);
      console.log(`      ${r.ref}`);
      if (r.text) console.log(`      ${r.text.replace(/\n/g, '\n      ')}`);
    }
  }

  if (!total) {
    console.log('\n  no hits. Note: identifier-shaped queries (paths, file names, hyphenated');
    console.log('  slugs) are relaxed automatically, but try plain prose words too.');
  }
}

if (require.main === module) main();
module.exports = { parseArgs, SOURCES };

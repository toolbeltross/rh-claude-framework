// recall-sources.js — one adapter per memory store, all returning the SAME record shape.
//
// WHY AN ADAPTER LAYER:
//   1. `scribe_rows` is a standing deletion candidate under the 2026-07-29 subtraction
//      mandate. Nothing above this file may query it directly, so it can be dropped or
//      replaced without touching the recall command.
//   2. The machines differ. Some run the oversight system, some don't; each has its own
//      LOCAL Postgres. Every Postgres-backed source therefore degrades to [] rather than
//      throwing, so recall still works from the .md files alone. The .md files are the
//      system of record; Postgres is a fast local index over them.
//
// Uniform record: { source, ts, ref, title, text, score }
//   source — which store it came from        ref — file path or session id (clickable)
//   ts     — ISO-ish timestamp or null       score — 0..1 within its own source
//
// Ranking across heterogeneous stores is deliberately simple term-overlap, not TF-IDF:
// the corpus is small (hundreds of files, tens of thousands of messages) and an
// explainable score beats a marginally better opaque one.

const fs = require('fs');
const path = require('path');
const os = require('os');

let scribeDb = null, config = null;
try { scribeDb = require('./scribe-db'); } catch { /* no DB on this machine */ }
try { ({ config } = require('./config')); } catch { config = {}; }

const homeDir = () => process.env.HOME || process.env.USERPROFILE || os.homedir();
const claudeDir = () => (config && config.claudeDir) || path.join(homeDir(), '.claude');

// ─── query handling ──────────────────────────────────────────────────────────
/** Split a query into lowercase terms, also splitting identifier separators. */
function terms(q) {
  return String(q || '')
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .map(s => s.trim())
    .filter(s => s.length > 1);
}

/**
 * Postgres indexes a path/identifier as ONE atomic lexeme, so FTS cannot match a fragment
 * of it. Mirrors the relaxation in rh-transcript-search.js: split separators to spaces.
 */
function relax(q) {
  return String(q || '').replace(/[-._/\\:]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Term-overlap score in 0..1, with a boost when terms hit the title. */
function scoreText(qTerms, text, title) {
  if (!qTerms.length) return 0;
  const hay = String(text || '').toLowerCase();
  const head = String(title || '').toLowerCase();
  let hits = 0, titleHits = 0;
  for (const t of qTerms) {
    if (hay.includes(t)) hits++;
    if (head.includes(t)) titleHits++;
  }
  if (!hits && !titleHits) return 0;
  const base = hits / qTerms.length;
  const boost = titleHits ? 0.25 * (titleHits / qTerms.length) : 0;
  return Math.min(1, base * 0.8 + boost + 0.2 * (titleHits ? 1 : 0) * 0);
}

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

/** Window the text around the first matching term so snippets are relevant, not just heads. */
function snippet(text, qTerms, width = 260) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const low = t.toLowerCase();
  let at = -1;
  for (const q of qTerms) { const i = low.indexOf(q); if (i >= 0 && (at < 0 || i < at)) at = i; }
  if (at < 0) return clip(t, width);
  const start = Math.max(0, at - Math.floor(width / 3));
  return (start > 0 ? '…' : '') + clip(t.slice(start), width);
}

// ─── Postgres-backed sources (degrade to [] when unavailable) ────────────────
function dbUsable() {
  return !!(scribeDb && config && config.scribeDb);
}

// TWO DIFFERENT DEGRADED STATES, and conflating them hid a real failure (2026-08-06).
//   (a) NOT CONFIGURED   — config.scribeDb false. Expected on a machine without the
//                          oversight system. Reported, and it always was.
//   (b) CONFIGURED BUT UNREACHABLE — flag on, but psql is missing / the service is down /
//                          the port is wrong. Every query fails, all three Postgres-backed
//                          sources return empty, and the ONLY signal is their absence.
//
// `available()` used to report the CONFIG FLAG, so (b) produced a completely silent
// zero-result recall — indistinguishable from "searched and found nothing". A peer session
// reported exactly this and I could not reproduce it against a healthy DB; the report was
// right and the reproduction was wrong. Verified by forcing RH_SCRIBE_PSQL at a bad path.
//
// Rather than probe up front (an extra psql spawn on every run, and a probe can disagree
// with the real queries), record whether the queries THEMSELVES failed. Zero added cost and
// strictly more accurate — it reports observed failure, not predicted failure.
let _dbFailed = false;
let _dbLastError = null;
/** Reset between logical runs; exported for tests. */
function resetDbHealth() { _dbFailed = false; _dbLastError = null; }

function pgSearch(sql, timeout = 20000) {
  if (!dbUsable()) return null;
  try {
    const r = scribeDb.runSql(sql, timeout);
    if (!r.ok) { _dbFailed = true; _dbLastError = String(r.error || 'query failed'); return null; }
    return JSON.parse(r.stdout || '[]');
  } catch (e) {
    _dbFailed = true; _dbLastError = String((e && e.message) || e);
    return null;
  }
}

function searchTranscripts(query, { limit = 8, days = null } = {}) {
  if (!dbUsable()) return [];
  const q = scribeDb.dollarQuote(query);
  const qr = scribeDb.dollarQuote(relax(query));
  const dayClause = days ? `AND m.ts > now() - interval '${parseInt(days, 10)} days'` : '';
  // Try the literal query, then the relaxed one — identifier-shaped queries match nothing
  // under websearch_to_tsquery because of atomic path tokens.
  for (const qq of [q, qr]) {
    const rows = pgSearch(`
      SELECT coalesce(json_agg(x),'[]'::json) FROM (
        SELECT m.session_id, t.project_slug, m.role, m.ts::text AS ts,
               ts_rank(m.content_tsv, websearch_to_tsquery('english', ${qq})) AS rank,
               left(m.content, 900) AS content
        FROM transcript_messages m JOIN transcripts t USING (session_id)
        WHERE m.content_tsv @@ websearch_to_tsquery('english', ${qq}) ${dayClause}
        ORDER BY rank DESC, m.ts DESC LIMIT ${limit}
      ) x;`, 30000);
    if (rows && rows.length) {
      const max = Math.max(...rows.map(r => Number(r.rank) || 0)) || 1;
      const qt = terms(query);
      return rows.map(r => ({
        source: 'transcript',
        ts: r.ts,
        ref: `${String(r.session_id).slice(0, 8)} · ${String(r.project_slug || '').replace(/^C--Users-[^-]+-/, '')}`,
        title: `${r.role} turn`,
        text: snippet(r.content, qt),
        score: Math.min(1, (Number(r.rank) || 0) / max),
      }));
    }
  }
  return [];
}

function searchLogs(query, { limit = 5, days = null } = {}) {
  if (!dbUsable()) return [];
  const q = scribeDb.dollarQuote(relax(query));
  const dayClause = days ? `AND l.ts > now() - interval '${parseInt(days, 10)} days'` : '';
  const rows = pgSearch(`
    SELECT coalesce(json_agg(x),'[]'::json) FROM (
      SELECT l.source, l.ts::text AS ts,
             ts_rank(l.content_tsv, websearch_to_tsquery('english', ${q})) AS rank,
             left(l.content, 500) AS content
      FROM log_entries l
      WHERE l.content_tsv @@ websearch_to_tsquery('english', ${q}) ${dayClause}
      ORDER BY rank DESC, l.ts DESC LIMIT ${limit}
    ) x;`);
  if (!rows) return [];
  const max = Math.max(...rows.map(r => Number(r.rank) || 0)) || 1;
  const qt = terms(query);
  return rows.map(r => ({
    source: 'log', ts: r.ts, ref: r.source, title: r.source,
    text: snippet(r.content, qt), score: Math.min(1, (Number(r.rank) || 0) / max),
  }));
}

/**
 * Scribe rows INCLUDING their LLM proposals. The proposals are the highest-value and
 * least-visible asset here: 232 rows carry an analysis nothing ever surfaced to a session.
 */
function searchScribe(query, { limit = 8 } = {}) {
  if (!dbUsable()) return [];
  const q = scribeDb.dollarQuote(relax(query));
  const rows = pgSearch(`
    SELECT coalesce(json_agg(x),'[]'::json) FROM (
      SELECT bucket, row_id, status, source_file, ts::text AS ts,
             left(content, 600) AS content,
             left(coalesce(proposed_disposition,''), 200) AS prop,
             left(coalesce(proposed_rationale,''), 300)  AS prop_why
      FROM scribe_rows
      WHERE to_tsvector('english', content) @@ websearch_to_tsquery('english', ${q})
      ORDER BY (proposed_at IS NOT NULL) DESC, ts DESC NULLS LAST LIMIT ${limit}
    ) x;`);
  if (!rows) return [];
  const qt = terms(query);
  return rows.map(r => ({
    source: r.bucket === 'learnings' ? 'scribe-learning' : `scribe-${r.bucket}`,
    ts: r.ts, ref: `${r.source_file}#${r.row_id}`,
    title: `${r.bucket} · ${r.status}`,
    text: snippet(r.content, qt) + (r.prop ? `\n      ↳ proposal: ${clip(r.prop, 160)}${r.prop_why ? ` — ${clip(r.prop_why, 200)}` : ''}` : ''),
    score: scoreText(qt, r.content, r.status),
  }));
}

// ─── filesystem sources (always available — .md is the system of record) ─────
// CRLF TOLERANCE IS LOAD-BEARING (found 2026-08-06 by a peer session, in prod data).
// A bare /^---\n/ cannot match `---\r\n`, so a single CRLF-line-ending file had its ENTIRE
// frontmatter go invisible — no name, no description — and the raw frontmatter block then
// leaked into the body text downstream. Exactly one of 23 memory files was CRLF, which is
// how it survived unnoticed. These files are hand-edited across several devices and editors,
// so mixed line endings are expected, not exceptional. Every anchor here is \r?\n.
const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---/;
/** Strip a leading frontmatter block, CRLF-safe. Exported shape used by scanDir. */
function stripFrontmatter(txt) {
  return String(txt || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}
function frontmatter(txt) {
  const m = FM_RE.exec(String(txt || ''));
  if (!m) return {};
  const o = {};
  for (const ln of m[1].split(/\r?\n/)) {
    const kv = /^\s*([\w-]+):\s*(.*)$/.exec(ln);
    // trim BEFORE stripping quotes — a trailing \r would otherwise sit between the closing
    // quote and end-of-string, defeating the `["']$` anchor and leaving quotes in the value.
    if (kv) o[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '').trim();
  }
  return o;
}

function scanDir(dir, qTerms, source, limit, extra = {}) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md') || f === 'MEMORY.md') continue;
    const p = path.join(dir, f);
    let txt; try { txt = fs.readFileSync(p, 'utf8'); } catch { continue; }
    const meta = frontmatter(txt);
    const slug = f.replace(/\.md$/, '');
    const title = meta.name || slug;
    const s = scoreText(qTerms, txt, slug + ' ' + title + ' ' + (meta.description || ''));
    if (s <= 0) continue;
    out.push({
      source, ts: meta.created || null, ref: p.replace(/\\/g, '/'),
      title, text: meta.description ? clip(meta.description, 260) : snippet(stripFrontmatter(txt), qTerms),
      score: s, ...extra,
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

function searchLearnings(query, { limit = 8 } = {}) {
  return scanDir(path.join(claudeDir(), 'memory-shared', 'learnings'), terms(query), 'learning', limit);
}

function searchProjectMemory(query, { limit = 8 } = {}) {
  const qt = terms(query);
  const root = path.join(claudeDir(), 'projects');
  if (!fs.existsSync(root)) return [];
  let out = [];
  for (const d of fs.readdirSync(root)) {
    const m = path.join(root, d, 'memory');
    if (fs.existsSync(m)) out = out.concat(scanDir(m, qt, 'project-memory', limit));
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** MCP knowledge graph — entity match plus its immediate edges (the far-flung links). */
function searchGraph(query, { limit = 6 } = {}) {
  const f = path.join(claudeDir(), 'memory-mcp-graph.json');
  if (!fs.existsSync(f)) return [];
  const qt = terms(query);
  const entities = [], relations = [];
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'entity') entities.push(o);
    else if (o.type === 'relation') relations.push(o);
  }
  const hits = entities
    .map(e => ({ e, s: scoreText(qt, (e.observations || []).join(' ') + ' ' + e.name, e.name) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit);
  return hits.map(({ e, s }) => {
    const edges = relations.filter(r => r.from === e.name || r.to === e.name);
    const linked = edges
      .filter(r => r.relationType === 'references')
      .map(r => (r.from === e.name ? r.to : r.from));
    // Prefer the backing file as the ref — the entity name is already the title, and a
    // path is what someone actually wants to open.
    const fileObs = (e.observations || []).find(o => /^file: /.test(o));
    return {
      source: 'graph', ts: null,
      ref: fileObs ? fileObs.slice(6) : e.name,
      title: `${e.name} [${e.entityType}]`,
      text: clip((e.observations || [])[1] || (e.observations || [])[0] || '', 220) +
            (linked.length ? `\n      ↳ links: ${linked.slice(0, 6).join(', ')}` : '') +
            `\n      ↳ ${edges.length} edge(s)`,
      score: s,
    };
  });
}

/**
 * Which stores are usable on THIS machine — recall reports degradation honestly.
 *
 * Call AFTER the searches: `postgres` reflects whether the queries actually succeeded, not
 * merely whether the DB is configured. Before any search runs, a configured-but-unreachable
 * DB still reports postgres:true, because nothing has failed yet.
 */
function available() {
  const configured = dbUsable();
  return {
    postgres: configured && !_dbFailed,   // usable in practice
    postgresConfigured: configured,       // the flag says it should be there
    postgresFailed: configured && _dbFailed, // configured, but every query failed
    postgresError: _dbLastError,
    learnings: fs.existsSync(path.join(claudeDir(), 'memory-shared', 'learnings')),
    projectMemory: fs.existsSync(path.join(claudeDir(), 'projects')),
    graph: fs.existsSync(path.join(claudeDir(), 'memory-mcp-graph.json')),
  };
}

module.exports = {
  terms, relax, scoreText, snippet, clip, available,
  frontmatter, stripFrontmatter, resetDbHealth,
  searchTranscripts, searchLogs, searchScribe,
  searchLearnings, searchProjectMemory, searchGraph,
};

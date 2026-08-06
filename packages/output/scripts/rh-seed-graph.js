#!/usr/bin/env node
/**
 * seed-graph.js — Phase 4: seed the MCP knowledge graph from the memory corpus.
 *
 * Writes the server's own store format directly (JSONL at MEMORY_FILE_PATH, one
 * {type:"entity"|"relation"} per line — verified against the package's saveGraph()).
 * The server calls loadGraph() per operation, so a direct write is picked up without
 * restarting it.
 *
 * DESIGN CONSTRAINTS (both verified at source):
 *  1. Entity name = FILE SLUG. `[[links]]` target filenames, not the `name:` frontmatter
 *     value (learnings put a prose Title there; memory files put a slug). Verified against
 *     [[local-env-blockers]] -> local-env-blockers.md.
 *  2. `search_nodes` is case-insensitive SUBSTRING matching over name/entityType/
 *     observations (dist/index.js:159-160) — NOT semantic. So observations must carry the
 *     literal keywords, identifiers and paths someone would actually type.
 *
 * EDGES ARE FACTS, NOT INFERENCES:
 *   references  — an authored [[link]] in the file
 *   derived-in  — the file's own originSessionId frontmatter
 *   scoped-to   — which project's memory dir the file lives in
 * Session/project nodes exist so provenance is traversable without inventing
 * learning-to-learning similarity edges.
 *
 * Usage: node seed-graph.js [--apply]
 */
const fs = require('fs');
const path = require('path');

// Home resolved at runtime -- this must work on every device and both accounts.
const homeDir = () => process.env.HOME || process.env.USERPROFILE || require('os').homedir();
// split/join rather than a regex: this string is rewritten by tooling often enough that
// backslash escaping is a liability, and the intent is plainer.
const CLAUDE = (homeDir() + '/.claude').split('\\').join('/');
const OUT = CLAUDE + '/memory-mcp-graph.json';
const APPLY = process.argv.includes('--apply');

// REUSE the shipped parser rather than keeping a second copy. The two had drifted-by-
// duplication: both carried a bare /^---\n/, so the single CRLF memory file of 23 had its
// entire frontmatter go invisible HERE TOO — that entity was seeded with no description and
// a wrong entityType, with the raw frontmatter block leaking into its first observation.
// Requiring the deployed lib means a fix in one place can never again miss the other.
const RS = require('./lib/recall-sources.js');
const fm = RS.frontmatter;
const LINK_RE = /\[\[([^\]]+)\]\]/g;
const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');

function scan(dir, kind, project) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md') || f === 'MEMORY.md') continue;
    const p = path.join(dir, f);
    const txt = fs.readFileSync(p, 'utf8');
    const meta = fm(txt);
    // First paragraph of the body = the substantive claim; good substring-search fodder.
    const body = RS.stripFrontmatter(txt);
    const firstPara = (body.split(/\n\s*\n/).map(s => s.trim()).find(s => s && !s.startsWith('#')) || '')
      .replace(/\s+/g, ' ');
    out.push({
      kind, project: project || null,
      slug: f.replace(/\.md$/, ''),
      file: p.replace(/\\/g, '/'),
      title: meta.name || '',
      description: meta.description || '',
      type: meta.type || meta.node_type || '',
      created: meta.created || '',
      session: meta.originSessionId || '',
      // Lifecycle vocabulary agreed with the rh-platform-agentbuild session 2026-08-06.
      // scope:  workspace | project | task | session-generalized
      // status: active | active-elsewhere | needs-user-confirmation | retired
      // RETIRED means kept-with-a-tombstone, never deleted, so inbound edges still resolve.
      scope: meta.scope || '',
      status: meta.status || '',
      assertedOn: meta.assertedOn || '',
      recheckAt: meta.recheckAt || '',
      retiredOn: meta.retiredOn || '',
      supersededBy: meta.supersededBy || '',
      taskName: meta.taskName || '',
      appliesInCwd: meta.appliesInCwd || '',
      links: [...txt.matchAll(LINK_RE)].map(m => m[1].trim()),
      firstPara,
    });
  }
  return out;
}

const items = scan(path.join(CLAUDE, 'memory-shared', 'learnings'), 'learning');
const projRoot = path.join(CLAUDE, 'projects');
for (const d of fs.readdirSync(projRoot)) {
  const m = path.join(projRoot, d, 'memory');
  if (fs.existsSync(m)) items.push(...scan(m, 'memory', d));
}

// NAME COLLISION ACROSS STORES (found 2026-08-06 by the rh-platform-agentbuild session).
// The same basename can exist in BOTH memory-shared/learnings and a project's memory dir with
// DIFFERENT content — e.g. end-turn-rec-summary.md exists in both, one tagged
// `status: active`, the other untagged. Keying entities by bare slug made them two entities
// sharing one name, so a name-keyed lookup could return the untagged copy and shadow the
// audited one — reintroducing, at the graph layer, exactly the staleness the scope work
// exists to prevent. A Map keyed by slug also let the LAST file silently win.
//
// Fix: bySlug holds ALL candidates; colliding slugs get a store-qualified key. Non-colliding
// slugs keep their bare name so 511 of 515 stay clean and stable.
const bySlug = new Map();
for (const i of items) {
  if (!bySlug.has(i.slug)) bySlug.set(i.slug, []);
  bySlug.get(i.slug).push(i);
}
const shortProject = (p) => String(p || '').split('-').slice(-1)[0] || 'project';
for (const [slug, group] of bySlug) {
  if (group.length === 1) { group[0].key = slug; continue; }
  for (const i of group) i.key = (i.kind === 'learning' ? 'shared' : shortProject(i.project)) + ':' + slug;
}
const COLLISIONS = [...bySlug.entries()].filter(([, g]) => g.length > 1);
const entities = [];
const relations = [];
const seenRel = new Set();
const addRel = (from, to, relationType) => {
  const k = `${from}|${relationType}|${to}`;
  if (from && to && from !== to && !seenRel.has(k)) { seenRel.add(k); relations.push({ from, to, relationType }); }
};

for (const it of items) {
  // Observations carry literal, typeable text — search_nodes is substring-only.
  const obs = [];
  if (it.title) obs.push(it.title);
  if (it.description) obs.push(it.description);
  if (it.firstPara) obs.push(clip(it.firstPara, 600));
  obs.push(`file: ${it.file}`);
  if (it.created) obs.push(`created: ${it.created}`);
  if (it.project) obs.push(`project: ${it.project}`);
  // Lifecycle fields emitted as `key: value` observations so search_nodes (substring-only)
  // can find them — e.g. searching "status: retired" or "scope: workspace" now works.
  // Untagged files get an explicit marker rather than silence, so "not yet audited" is
  // distinguishable from "audited and found active".
  for (const k of ['scope', 'status', 'assertedOn', 'recheckAt', 'retiredOn', 'supersededBy', 'taskName', 'appliesInCwd']) {
    if (it[k]) obs.push(`${k}: ${it[k]}`);
  }
  if (!it.status) obs.push('status: untagged (not yet audited)');
  // `store:` on EVERY entity, not just colliding ones — which store a memory came from is
  // queryable state, and search_nodes is substring-only so it has to be literal text.
  obs.push(`store: ${it.kind === 'learning' ? 'shared' : 'project'}`);
  if (it.key !== it.slug) obs.push(`slug: ${it.slug} (name qualified — same slug exists in another store)`);
  entities.push({
    name: it.key,
    entityType: it.kind === 'learning' ? 'learning' : `memory-${it.type || 'note'}`,
    observations: obs.filter(Boolean),
  });
}

// Session + project nodes (provenance, traversable without inventing similarity edges)
const sessions = new Set(items.map(i => i.session).filter(Boolean));
for (const s of sessions) entities.push({ name: `session:${s}`, entityType: 'session', observations: [`Claude Code session ${s}`] });
const projects = new Set(items.map(i => i.project).filter(Boolean));
for (const p of projects) entities.push({ name: `project:${p}`, entityType: 'project', observations: [`per-project memory dir: ~/.claude/projects/${p}/memory`] });

let dangling = 0, ambiguous = 0;
for (const it of items) {
  for (const l of new Set(it.links)) {
    const group = bySlug.get(l);
    if (!group) { dangling++; continue; }
    let target = group[0];
    if (group.length > 1) {
      // A [[link]] carries a bare slug, so a colliding target needs disambiguating. Resolve
      // STORE-LOCALLY: a learning linking [[x]] means the shared x; a project memory means
      // its own. If that still doesn't single one out, SKIP and count it — guessing here
      // would silently attach an edge to the wrong memory, which is worse than no edge.
      const sameStore = group.filter(g => g.kind === it.kind && g.project === it.project);
      if (sameStore.length === 1) target = sameStore[0];
      else { ambiguous++; continue; }
    }
    addRel(it.key, target.key, 'references');
  }
  if (it.session) addRel(it.key, `session:${it.session}`, 'derived-in');
  if (it.project) addRel(it.key, `project:${it.project}`, 'scoped-to');
}

const byType = {};
for (const e of entities) byType[e.entityType] = (byType[e.entityType] || 0) + 1;
const relByType = {};
for (const r of relations) relByType[r.relationType] = (relByType[r.relationType] || 0) + 1;

console.log(APPLY ? 'SEED (APPLYING)' : 'SEED (dry-run)');
console.log('  entities :', entities.length, JSON.stringify(byType));
console.log('  relations:', relations.length, JSON.stringify(relByType));
console.log('  dangling [[links]] skipped:', dangling);
console.log('  ambiguous [[links]] skipped (colliding slug, no store-local match):', ambiguous);
console.log('  slug collisions across stores:', COLLISIONS.length);
for (const [slug, g] of COLLISIONS) console.log('     ' + slug + ' -> ' + g.map(x => x.key).join('  |  '));

if (!APPLY) { console.log('\nre-run with --apply'); process.exit(0); }

if (fs.existsSync(OUT)) fs.copyFileSync(OUT, OUT + '.bak-' + Date.now());
const lines = [
  ...entities.map(e => JSON.stringify({ type: 'entity', name: e.name, entityType: e.entityType, observations: e.observations })),
  ...relations.map(r => JSON.stringify({ type: 'relation', from: r.from, to: r.to, relationType: r.relationType })),
];
fs.writeFileSync(OUT, lines.join('\n') + '\n');
console.log(`\nwrote ${lines.length} lines -> ${OUT}`);

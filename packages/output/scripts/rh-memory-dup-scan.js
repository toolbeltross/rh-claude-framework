// Triage the 0.15-0.30 raw-Jaccard band, which is ~400 pairs and not readable one by one.
//
// Raw Jaccard is the wrong instrument here and BOTH sessions proved it independently:
//   - it flags unrelated pairs at 0.38 (shared workspace jargon: git, session, worktree, windows)
//   - it MISSES a real duplicate at 0.146 (end-turn-rec-summary, the most consequential find)
// So the answer is a better discriminator, not more reading.
//
// Three signals, each cheap and each independent of the others:
//   1. IDF-WEIGHTED COSINE — a term shared by 200 files carries almost no evidence; a term
//      shared by 2 carries a lot. This directly attacks the shared-vocabulary inflation.
//   2. SAME ORIGIN SESSION — nearly every confirmed duplicate so far came from ONE session
//      writing the same lesson twice (1399e111 x2, 25d7395b, F-15). Structural, not textual.
//   3. TITLE/DESCRIPTION overlap — frontmatter is hand-written and dense; body prose is not.
//
// A pair is shortlisted if IDF-cosine is high, OR it shares an origin session and has any
// meaningful overlap. Union, not intersection — each signal catches what the others miss.
const fs = require('fs'), path = require('path');
const RS = require('./lib/recall-sources.js');
const homeDir = () => process.env.HOME || process.env.USERPROFILE || require('os').homedir();
// path.join keeps native separators; Node accepts mixed separators on Windows, and every
// consumer here is fs.*, so no normalisation is needed.
const L = path.join(homeDir(), '.claude', 'memory-shared', 'learnings');

const STOP = new Set(('the a an and or but if then than that this these those is are was were be been being of to in on at by for with from as it its into about over under not no so such can may might will would should could do does did have has had you your we our they their i me my he she them us one two also more most other some any each per via when where which who whom what how why all both few many much very just only same own too s t don now here there'.split(' ')));
const toks = (s) => String(s).toLowerCase().replace(/```[\s\S]*?```/g, ' ')
  .split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOP.has(w));

const docs = [];
for (const f of fs.readdirSync(L)) {
  if (!f.endsWith('.md') || f === 'MEMORY.md') continue;
  const txt = fs.readFileSync(path.join(L, f), 'utf8');
  const fm = RS.frontmatter(txt);
  // Cut appended link/merge blocks: they quote the peer and would fake similarity.
  const body = RS.stripFrontmatter(txt).split(/^###\s+(?:Merged from|Peer memory in the other store|Related memory in this store)/m)[0];
  docs.push({
    slug: f.replace(/\.md$/, ''),
    session: (fm.originSessionId || fm.origin || '').slice(0, 8),
    head: new Set(toks((fm.name || '') + ' ' + (fm.description || ''))),
    tf: (() => { const m = new Map(); for (const t of toks(body)) m.set(t, (m.get(t) || 0) + 1); return m; })(),
    raw: new Set(toks(body)),
  });
}

// IDF over the corpus.
const df = new Map();
for (const d of docs) for (const t of d.raw) df.set(t, (df.get(t) || 0) + 1);
const N = docs.length;
const idf = (t) => Math.log(N / (1 + (df.get(t) || 0)));

for (const d of docs) {
  let norm = 0; d.vec = new Map();
  for (const [t, c] of d.tf) { const w = (1 + Math.log(c)) * idf(t); d.vec.set(t, w); norm += w * w; }
  d.norm = Math.sqrt(norm) || 1;
}
const cos = (a, b) => {
  const [s, l] = a.vec.size < b.vec.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [t, w] of s.vec) { const w2 = l.vec.get(t); if (w2) dot += w * w2; }
  return dot / (a.norm * b.norm);
};
const jac = (a, b) => { let i = 0; for (const t of a.raw) if (b.raw.has(t)) i++; const u = a.raw.size + b.raw.size - i; return u ? i / u : 0; };

const hits = [];
for (let i = 0; i < docs.length; i++) for (let j = i + 1; j < docs.length; j++) {
  const a = docs[i], b = docs[j];
  const J = jac(a, b);
  if (J >= 0.30) continue;              // already triaged
  if (J < 0.10) continue;               // below any plausible floor
  const C = cos(a, b);
  const sameSession = a.session && a.session === b.session;
  let hj = 0; for (const t of a.head) if (b.head.has(t)) hj++;
  const headOverlap = hj / (Math.min(a.head.size, b.head.size) || 1);
  const why = [];
  if (C >= 0.30) why.push('idf-cos ' + C.toFixed(2));
  if (sameSession && C >= 0.18) why.push('SAME SESSION ' + a.session);
  if (headOverlap >= 0.45) why.push('title/desc ' + headOverlap.toFixed(2));
  if (why.length) hits.push({ a: a.slug, b: b.slug, J, C, why: why.join(' | ') });
}
hits.sort((x, y) => y.C - x.C);
console.log(`band 0.10-0.30 raw Jaccard: ${hits.length} shortlisted by IDF-cosine / same-session / title\n`);
for (const h of hits) console.log(`  jac ${h.J.toFixed(2)}  cos ${h.C.toFixed(2)}  ${h.a}  ~  ${h.b}\n        ${h.why}`);

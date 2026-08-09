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

// ─── corpora ────────────────────────────────────────────────────────────────
// Default: score one directory against ITSELF (live learnings, all pairs).
// With --corpus-b: score A against B instead — e.g. an archive tree against the
// live store. Requested by the session integrating ~145 archive learnings, whose
// files sit outside ~/.claude entirely. One scorer, two modes, rather than a
// second metric: two sessions with two scorers produce two answers on the same
// field, which is precisely what the tiebreak rule exists to clean up after.
const ARGV = process.argv.slice(2);
const argOf = (n) => { const i = ARGV.indexOf(n); return i >= 0 ? ARGV[i + 1] : null; };
const DIR_A = argOf('--corpus-a') || L;
const DIR_B = argOf('--corpus-b');          // null => within-corpus mode
const CROSS = !!DIR_B;

function load(dir, label) {
  const out = [];
  if (!fs.existsSync(dir)) { console.error(`corpus not found: ${dir}`); process.exit(1); }
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md') || f === 'MEMORY.md') continue;
    const txt = fs.readFileSync(path.join(dir, f), 'utf8');
    const fm = RS.frontmatter(txt);
    // Cut appended link/merge blocks: they quote the peer and would fake similarity.
    const body = RS.stripFrontmatter(txt).split(/^###\s+(?:Merged from|Peer memory in the other store|Related memory in this store)/m)[0];
    out.push({
      corpus: label,
      slug: f.replace(/\.md$/, ''),
      session: (fm.originSessionId || fm.origin || '').slice(0, 8),
      head: new Set(toks((fm.name || '') + ' ' + (fm.description || ''))),
      tf: (() => { const m = new Map(); for (const t of toks(body)) m.set(t, (m.get(t) || 0) + 1); return m; })(),
      raw: new Set(toks(body)),
    });
  }
  return out;
}

const A = load(DIR_A, 'A');
const B = CROSS ? load(DIR_B, 'B') : [];
const docs = A.concat(B);

// IDF over the UNION of both corpora. Computing it per-corpus would give the same
// term two different weights and make cross-corpus scores incomparable.
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

// Candidate pairs. Within-corpus: upper triangle of A. Cross-corpus: A x B only —
// B-vs-B is not this run's question and would bury the signal.
const pairs = [];
if (CROSS) { for (const a of A) for (const b of B) pairs.push([a, b]); }
else { for (let i = 0; i < A.length; i++) for (let j = i + 1; j < A.length; j++) pairs.push([A[i], A[j]]); }

const hits = [];
for (const [a, b] of pairs) {
  const J = jac(a, b);
  const C = cos(a, b);
  const sameSession = a.session && a.session === b.session;
  let hj = 0; for (const t of a.head) if (b.head.has(t)) hj++;
  const headOverlap = hj / (Math.min(a.head.size, b.head.size) || 1);

  // NAME MATCH — first-class, and ONLY meaningful across corpora. Filenames inside a
  // single directory are necessarily unique, so this signal is structurally inert in
  // within-corpus mode (verified: 0 duplicate basenames among 375 live learnings) and
  // would be a confident-looking no-op if reported there. Across corpora it is the
  // strongest signal available: it caught a genuine duplicate scoring 0.146 that no
  // content metric ranked, and a peer's 257-file run found 72 name-only hits that the
  // content score missed entirely. Promote regardless of score.
  const nameMatch = CROSS && a.slug === b.slug;

  if (!nameMatch) {
    if (J >= 0.30) continue;            // already triaged by the earlier sweep
    if (J < 0.10) continue;             // below any plausible floor
  }

  const why = [];
  if (nameMatch) why.push('NAME MATCH (exact slug)');
  if (C >= 0.30) why.push('idf-cos ' + C.toFixed(2));
  if (sameSession && C >= 0.18) why.push('SAME SESSION ' + a.session);
  if (headOverlap >= 0.45) why.push('title/desc ' + headOverlap.toFixed(2));
  if (why.length) hits.push({ a: a.slug, b: b.slug, J, C, nameMatch, why: why.join(' | ') });
}
// Name matches first — they are the class content scoring provably misses.
hits.sort((x, y) => (y.nameMatch - x.nameMatch) || (y.C - x.C));

const mode = CROSS ? `CROSS-CORPUS  A=${DIR_A}  (${A.length})  x  B=${DIR_B}  (${B.length})`
                   : `WITHIN-CORPUS  ${DIR_A}  (${A.length} files)`;
console.log(mode);
console.log(`${hits.length} shortlisted by ${CROSS ? 'name-match / ' : ''}IDF-cosine / same-session / title`);
if (CROSS) console.log(`  (${hits.filter(h => h.nameMatch).length} of them by NAME — the class content scoring misses)`);
console.log();
for (const h of hits) console.log(`  jac ${h.J.toFixed(2)}  cos ${h.C.toFixed(2)}  ${h.a}  ~  ${h.b}\n        ${h.why}`);
console.log('\nA score locates candidates. It does not license the edit — read both files.');

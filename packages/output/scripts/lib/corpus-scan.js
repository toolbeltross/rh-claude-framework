// corpus-scan.js — one readdir+frontmatter loop for every corpus consumer.
//
// Plan steps 2.1 + 1.3. Consolidates the walk that had been copied into
// rh-seed-graph.js, the artifact indexer, and the recall sources, and adds the
// three things every consumer needed but only some had: a content hash, an
// mtime, and a portable path key.
//
// ---------------------------------------------------------------------------
// THE PRIVACY GATE IS A TWO-CALL PROTOCOL, AND THE ORDER IS THE POINT (1.3).
//
//   call 1: classifyDisposition({canonicalPath, sourceKind})  <-- NO content
//           path-based exclusion returns here, BEFORE the file is ever opened.
//   read:   only if call 1 did not block
//   call 2: classifyDisposition({canonicalPath, sourceKind, content})
//           content-based PII scan, now that reading is permitted.
//
// A single call with content would require reading a blocklisted file in order
// to decide not to read it. That is not a theoretical distinction: it is the
// difference between "the private tree was never opened" and "the private tree
// was opened and then discarded", and only the first is what the standing
// ruling actually says.
//
// OUTPUT HYGIENE: a blocked entry contributes to counts ONLY. Its filename,
// path and content never enter the return value, so a caller cannot leak what
// it never received. `blockedPaths` is deliberately not provided.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RS = require('./recall-sources.js');
const pathKey = require('./path-key.js');
const { classifyDisposition } = require('./context-db.js');

// Generated index files are not corpus content; every prior copy of this loop
// skipped them and so does this one.
const SKIP_BASENAMES = new Set(['MEMORY.md']);

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Scan one directory of .md artifacts.
 *
 * @param {string} dir                 directory to scan (non-recursive, matching prior behaviour)
 * @param {object} [opts]
 * @param {string} [opts.sourceKind]   kind passed to classifyDisposition (default 'learnings_md')
 * @param {string[]} [opts.privateDirs] override the configured blocklist (tests)
 * @param {function} [opts.extract]    (ctx) => object — extra fields merged into the entry.
 *                                     ctx = {text, meta, body, file, slug}. Lets the graph
 *                                     fold its own loop in here without this module
 *                                     needing to know anything about graph edges.
 * @param {boolean} [opts.recursive]   walk subdirectories (default false)
 * @returns {{scanned:number, blocked:number, read:number, errors:number, entries:object[]}}
 *          `scanned` counts every candidate considered, blocked ones included.
 */
function scanCorpus(dir, opts = {}) {
  const sourceKind = opts.sourceKind || 'learnings_md';
  const extract = typeof opts.extract === 'function' ? opts.extract : null;
  const result = { scanned: 0, blocked: 0, read: 0, errors: 0, entries: [] };
  if (!dir || !fs.existsSync(dir)) return result;

  const files = [];
  (function walk(d) {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { result.errors++; return; }
    for (const e of ents) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (opts.recursive) walk(full); continue; }
      if (!e.name.endsWith('.md')) continue;
      if (SKIP_BASENAMES.has(e.name)) continue;
      files.push(full);
    }
  })(dir);

  for (const p of files) {
    result.scanned++;
    const file = p.split('\\').join('/');
    const canonicalPath = file;

    // --- CALL 1: path-only. Must precede any read. ---
    let disposition;
    try {
      disposition = classifyDisposition({ canonicalPath, sourceKind }, opts.privateDirs);
    } catch { result.errors++; continue; }
    if (disposition === 'blocklisted-skipped') { result.blocked++; continue; }

    // --- READ (permitted) ---
    let text, stat;
    try {
      text = fs.readFileSync(p, 'utf8');
      stat = fs.statSync(p);
    } catch { result.errors++; continue; }

    // --- CALL 2: content-aware. PII / blocklisted-content pass. ---
    try {
      disposition = classifyDisposition({ canonicalPath, sourceKind, content: text }, opts.privateDirs);
    } catch { result.errors++; continue; }
    if (disposition === 'blocklisted-skipped') { result.blocked++; continue; }

    result.read++;
    const meta = RS.frontmatter(text) || {};
    const body = RS.stripFrontmatter(text);
    const base = path.basename(p);

    const entry = {
      file,
      key: pathKey.toKey(file),          // portable key — see plan §0.B on absolute-key drift
      slug: base.replace(/\.md$/, ''),
      sourceKind,
      disposition,                        // 'clean' | 'review-required'
      contentSha256: sha256(text),
      bytes: Buffer.byteLength(text, 'utf8'),
      mtime: stat.mtime.toISOString(),
      title: meta.name || '',
      description: meta.description || '',
      type: meta.type || meta.node_type || '',
    };

    if (extract) {
      try { Object.assign(entry, extract({ text, meta, body, file, slug: entry.slug }) || {}); }
      catch { result.errors++; }
    }
    result.entries.push(entry);
  }

  return result;
}

module.exports = { scanCorpus, sha256, SKIP_BASENAMES };

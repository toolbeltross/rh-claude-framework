// Tests for rh-scribe-parity-audit.js — Phase 4.1 of
// PLAN-2026-06-11-scribe-postgres-fts.md. Pure helpers + audit core are
// covered with synthetic data / temp files; no live DB required.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const A = require(path.join(__dirname, '..', 'scripts', 'rh-scribe-parity-audit.js'));

function tmpFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-parity-test-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, 'utf8');
  return { dir, p };
}

const tests = [
  {
    name: 'normalizePath: backslashes → slashes, lowercased, trailing slash stripped',
    fn: () => {
      assert.strictEqual(A.normalizePath('C:\\Users\\X\\cleanup.md'), 'c:/users/x/cleanup.md');
      assert.strictEqual(A.normalizePath('C:/Users/X/'), 'c:/users/x');
      assert.strictEqual(A.normalizePath(''), '');
      assert.strictEqual(A.normalizePath(null), '');
    },
  },
  {
    name: 'normalizePath: two spellings of the same path collapse to one key',
    fn: () => {
      assert.strictEqual(
        A.normalizePath('C:/ws/proj/cleanup.md'),
        A.normalizePath('C:\\ws\\proj\\cleanup.md')
      );
    },
  },
  {
    name: 'isTempPath: detects OS tmpdir, appdata temp, and test-fixture names',
    fn: () => {
      assert.strictEqual(A.isTempPath(path.join(os.tmpdir(), 'x.md')), true);
      assert.strictEqual(A.isTempPath('C:\\Users\\x\\AppData\\Local\\Temp\\rh-lw-test-AbCd\\rh-test-learning.md'), true);
      assert.strictEqual(A.isTempPath('/some/dir/rh-no-rule.md'), true);
      assert.strictEqual(A.isTempPath('C:/ws/proj/cleanup.md'), false);
    },
  },
  {
    name: 'parsePsqlRows: splits pipe-separated tuples into labeled objects',
    fn: () => {
      const rows = A.parsePsqlRows('abc123|C:/x/cleanup.md|open\ndef456|C:/x/cleanup.md|resolved', ['row_id', 'source_file', 'status']);
      assert.strictEqual(rows.length, 2);
      assert.deepStrictEqual(rows[0], { row_id: 'abc123', source_file: 'C:/x/cleanup.md', status: 'open' });
      assert.strictEqual(rows[1].status, 'resolved');
    },
  },
  {
    name: 'parsePsqlRows: empty/blank stdout → empty array',
    fn: () => {
      assert.deepStrictEqual(A.parsePsqlRows('', ['a']), []);
      assert.deepStrictEqual(A.parsePsqlRows('   \n  ', ['a']), []);
    },
  },
  {
    name: 'diffIdSets: matched / md_only / db_only computed correctly',
    fn: () => {
      const md = new Set(['a', 'b', 'c']);
      const db = new Set(['b', 'c', 'd']);
      const { matched, md_only, db_only } = A.diffIdSets(md, db);
      assert.deepStrictEqual(matched.sort(), ['b', 'c']);
      assert.deepStrictEqual(md_only.sort(), ['a']);
      assert.deepStrictEqual(db_only.sort(), ['d']);
    },
  },
  {
    name: 'parseTableIds: extracts hex ids from a tabular scribe file',
    fn: () => {
      const { p } = tmpFile('cleanup.md',
        '# Cleanup\n\n| id | ts | session | text | status |\n|---|---|---|---|---|\n' +
        '| f40fbd4382 | 2026-06-11T00:00:00Z | abc12345 | something | open |\n' +
        '| db88249854 | 2026-06-12T00:00:00Z | def67890 | another | resolved |\n' +
        '<!-- scribe-done -->\n');
      const ids = A.parseTableIds(p);
      assert.deepStrictEqual([...ids].sort(), ['db88249854', 'f40fbd4382']);
    },
  },
  {
    name: 'parseTableIds: header/separator/prose lines are ignored',
    fn: () => {
      const { p } = tmpFile('rec.md', '| id | ts | session | text | status |\n|---|---|---|---|---|\nnot a row\n');
      assert.strictEqual(A.parseTableIds(p).size, 0);
    },
  },
  {
    name: 'parseTableIds: missing file → null (distinct from empty set)',
    fn: () => {
      assert.strictEqual(A.parseTableIds(path.join(os.tmpdir(), 'definitely-missing-' + Date.now() + '.md')), null);
    },
  },
  {
    name: 'learningsOnDisk: lists topic basenames, excludes MEMORY.md and non-md',
    fn: () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-learn-test-'));
      fs.writeFileSync(path.join(dir, 'topic-one.md'), 'x');
      fs.writeFileSync(path.join(dir, 'topic-two.md'), 'x');
      fs.writeFileSync(path.join(dir, 'MEMORY.md'), 'x');
      fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
      const set = A.learningsOnDisk(dir);
      assert.deepStrictEqual([...set].sort(), ['topic-one', 'topic-two']);
    },
  },
  {
    name: 'learningsOnDisk: missing dir → null',
    fn: () => {
      assert.strictEqual(A.learningsOnDisk(path.join(os.tmpdir(), 'no-such-dir-' + Date.now())), null);
    },
  },
  {
    name: 'groupBySource: collapses path-spelling variants and flags drift',
    fn: () => {
      const rows = [
        { row_id: 'a', source_file: 'C:/x/cleanup.md', status: 'open' },
        { row_id: 'b', source_file: 'C:\\x\\cleanup.md', status: 'open' },
      ];
      const { groups, pathDrift, tempCount } = A.groupBySource(rows);
      assert.strictEqual(groups.size, 1, 'two spellings collapse to one group');
      assert.strictEqual(pathDrift.length, 1, 'drift reported');
      assert.strictEqual(pathDrift[0].spellings.length, 2);
      assert.strictEqual(tempCount, 0);
    },
  },
  {
    name: 'groupBySource: temp-path rows are excluded and counted',
    fn: () => {
      const rows = [
        { row_id: 'a', source_file: 'C:/x/cleanup.md', status: 'open' },
        { row_id: 't', source_file: path.join(os.tmpdir(), 'rh-lw-test-Z/leak.md'), status: 'open' },
      ];
      const { groups, tempCount } = A.groupBySource(rows);
      assert.strictEqual(groups.size, 1);
      assert.strictEqual(tempCount, 1);
    },
  },
  {
    name: 'auditTabularBucket: computes md_only gap against real md file',
    fn: () => {
      const { p } = tmpFile('recommendations.md',
        '| id | ts | session | text | status |\n|---|---|---|---|---|\n' +
        '| aaaa1111 | t | s | x | open |\n| bbbb2222 | t | s | y | open |\n| cccc3333 | t | s | z | open |\n');
      // DB has only one of the three md rows mirrored. Fixtures live under the
      // OS temp dir, so disable the temp filter for this diff-logic test.
      const noTemp = () => false;
      const rows = [{ row_id: 'aaaa1111', source_file: p, status: 'open' }];
      const res = A.auditTabularBucket('recommendations', rows, [], noTemp);
      assert.strictEqual(res.totals.md, 3);
      assert.strictEqual(res.totals.db, 1);
      assert.strictEqual(res.totals.matched, 1);
      assert.strictEqual(res.totals.md_only, 2);
      assert.strictEqual(res.totals.db_only, 0);
    },
  },
  {
    name: 'auditTabularBucket: db_only surfaces when a DB row has no md row',
    fn: () => {
      const { p } = tmpFile('cleanup.md', '| id | ts | session | text | status |\n|---|---|---|---|---|\n| aaaa1111 | t | s | x | open |\n');
      const rows = [
        { row_id: 'aaaa1111', source_file: p, status: 'open' },
        { row_id: 'orphan99', source_file: p, status: 'open' },
      ];
      const res = A.auditTabularBucket('cleanup', rows, [], () => false);
      assert.strictEqual(res.totals.db_only, 1);
      assert.strictEqual(res.totals.md_only, 0);
    },
  },
  {
    name: 'auditTabularBucket: missing md file flagged, all DB rows become db_only',
    fn: () => {
      const missing = path.join(os.tmpdir(), 'rh-missing-' + Date.now() + '.md');
      const rows = [{ row_id: 'aaaa1111', source_file: missing, status: 'open' }];
      const res = A.auditTabularBucket('cleanup', rows, [], () => false);
      assert.strictEqual(res.files[0].missing, true);
      assert.strictEqual(res.totals.db_only, 1);
    },
  },
  {
    name: 'auditTabularBucket: extra canonical file with zero DB rows shows full gap',
    fn: () => {
      const { p } = tmpFile('recommendations.md', '| id | ts | session | text | status |\n|---|---|---|---|---|\n| abcd9999 | t | s | x | open |\n');
      const res = A.auditTabularBucket('recommendations', [], [p], () => false);
      assert.strictEqual(res.totals.md, 1);
      assert.strictEqual(res.totals.db, 0);
      assert.strictEqual(res.totals.md_only, 1);
    },
  },
  {
    name: 'auditLearnings: disk-vs-db diff with temp pollution counted',
    fn: () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-learn-test-'));
      fs.writeFileSync(path.join(dir, 'kept.md'), 'x');     // in db
      fs.writeFileSync(path.join(dir, 'not-written.md'), 'x'); // md_only
      const rows = [
        { row_id: 'kept', source_file: path.join(dir, 'kept.md'), status: 'active' },
        { row_id: 'leak', source_file: path.join(os.tmpdir(), 'rh-lw-test-Q/x.md'), status: 'active' },
      ];
      // Fixtures are under tmpdir; flag only the rh-lw-test leak as pollution so
      // the real fixture still counts (the real isTempPath is tested separately).
      const res = A.auditLearnings(rows, dir, p => /rh-lw-test/.test(p));
      assert.strictEqual(res.totals.md, 2);
      assert.strictEqual(res.totals.db, 1, 'temp row excluded from db count');
      assert.strictEqual(res.totals.matched, 1);
      assert.strictEqual(res.totals.md_only, 1);
      assert.strictEqual(res.tempCount, 1);
      assert.deepStrictEqual(res.md_only_samples, ['not-written']);
    },
  },
  {
    name: 'hasDrift: true when md_only present, false on perfectly clean audit',
    fn: () => {
      const clean = { results: [{ bucket: 'cleanup', totals: { md: 2, db: 2, matched: 2, md_only: 0, db_only: 0 }, pathDrift: [], tempCount: 0 }], errors: [] };
      const dirty = { results: [{ bucket: 'cleanup', totals: { md: 2, db: 1, matched: 1, md_only: 1, db_only: 0 }, pathDrift: [], tempCount: 0 }], errors: [] };
      assert.strictEqual(A.hasDrift(clean), false);
      assert.strictEqual(A.hasDrift(dirty), true);
    },
  },
  {
    name: 'hasDrift: true when only a warning (path_drift or test_pollution) is present',
    fn: () => {
      const driftWarn = { results: [{ bucket: 'cleanup', totals: { md: 2, db: 2, matched: 2, md_only: 0, db_only: 0 }, pathDrift: [{ norm: 'x', spellings: ['a', 'b'] }], tempCount: 0 }], errors: [] };
      const tempWarn = { results: [{ bucket: 'learnings', totals: { md: 1, db: 1, matched: 1, md_only: 0, db_only: 0 }, pathDrift: [], tempCount: 2 }], errors: [] };
      assert.strictEqual(A.hasDrift(driftWarn), true);
      assert.strictEqual(A.hasDrift(tempWarn), true);
    },
  },
  {
    name: 'renderText: produces a verdict line and per-bucket section',
    fn: () => {
      const audit = { results: [{ bucket: 'cleanup', totals: { md: 2, db: 1, matched: 1, md_only: 1, db_only: 0 }, files: [], pathDrift: [], tempCount: 0 }], errors: [] };
      const txt = A.renderText(audit);
      assert.ok(txt.includes('### cleanup'));
      assert.ok(/VERDICT: drift present/.test(txt));
    },
  },
  {
    name: 'parseArgs: flags parsed',
    fn: () => {
      assert.deepStrictEqual(A.parseArgs(['--bucket', 'cleanup', '--json', '--strict']), { bucket: 'cleanup', json: true, strict: true });
      assert.deepStrictEqual(A.parseArgs([]), { bucket: null, json: false, strict: false });
    },
  },
];

module.exports = { tests };

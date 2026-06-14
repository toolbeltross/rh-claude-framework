// Tests for lib/scribe-db.js — postgres shadow writes (Phase 2,
// PLAN-2026-06-11-scribe-postgres-fts.md).
//
// Unit tests always run. The integration tests against a REAL rh_scribe
// database run only when RH_TEST_PG=1 (CI/machines without postgres skip
// them cleanly as named no-op passes).

const assert = require('assert');
const path = require('path');

const SHARED = path.join(__dirname, '..', '..', 'shared');
const LIB = path.join(__dirname, '..', 'scripts', 'lib');

function freshScribeDb(env) {
  // scribe-db captures the resolved config at require time, so a fresh
  // require (with cleared caches) is needed per env scenario.
  const prev = {};
  for (const [k, v] of Object.entries(env)) { prev[k] = process.env[k]; process.env[k] = v; }
  for (const m of [path.join(LIB, 'scribe-db.js'), path.join(LIB, 'config.js'), path.join(SHARED, 'config.js')]) {
    delete require.cache[require.resolve(m)];
  }
  require(path.join(SHARED, 'config.js')).resetCache();
  const mod = require(path.join(LIB, 'scribe-db.js'));
  // restore env immediately — config is already captured
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return mod;
}

const PG = process.env.RH_TEST_PG === '1';

const tests = [
  {
    name: 'writeRow is a skipped no-op when scribeDb flag is off',
    fn: () => {
      const db = freshScribeDb({ RH_SCRIBE_DB: '0' });
      const res = db.writeRow({ bucket: 'cleanup', row_id: 'test-noop', content: 'x' });
      assert.deepStrictEqual(res, { ok: true, skipped: true });
    },
  },
  {
    name: 'dollarQuote wraps payload in a tag absent from the payload',
    fn: () => {
      const db = freshScribeDb({ RH_SCRIBE_DB: '0' });
      for (const payload of ["plain", "it's $quoted$", "$qdeadbeef$ injection attempt $qdeadbeef$", "multi\nline | pipes"]) {
        const q = db.dollarQuote(payload);
        const m = q.match(/^\$(q[0-9a-f]{8})\$([\s\S]*)\$(q[0-9a-f]{8})\$$/);
        assert.ok(m, `quoted form malformed: ${q.slice(0, 40)}`);
        assert.strictEqual(m[1], m[3], 'open/close tags match');
        assert.strictEqual(m[2], payload, 'payload preserved verbatim');
        assert.ok(!payload.includes('$' + m[1] + '$'), 'tag not present in payload');
      }
    },
  },
  {
    name: 'canonicalSourceFile collapses backslash + forward-slash spellings of one path to one value',
    fn: () => {
      const db = freshScribeDb({ RH_SCRIBE_DB: '0' });
      const back = 'C:\\Users\\testuser\\Workspace\\cleanup.md';
      const fwd = 'C:/Users/testuser/Workspace/cleanup.md';
      assert.strictEqual(db.canonicalSourceFile(back), fwd, 'backslash spelling normalizes to forward-slash');
      assert.strictEqual(db.canonicalSourceFile(fwd), fwd, 'forward-slash spelling is unchanged');
      assert.strictEqual(db.canonicalSourceFile(back), db.canonicalSourceFile(fwd), 'both spellings collapse to one');
      // case preserved (Windows case-insensitive, but POSIX paths are not)
      assert.strictEqual(db.canonicalSourceFile('C:\\X\\Y.md'), 'C:/X/Y.md', 'case preserved');
      // null/empty passthrough
      assert.strictEqual(db.canonicalSourceFile(null), null);
      assert.strictEqual(db.canonicalSourceFile(undefined), undefined);
      assert.strictEqual(db.canonicalSourceFile(''), '');
    },
  },
  {
    name: 'writeRow never throws even with a broken psql path',
    fn: () => {
      const db = freshScribeDb({ RH_SCRIBE_DB: '1', RH_SCRIBE_PSQL: 'Z:/does/not/exist/psql.exe' });
      const res = db.writeRow({ bucket: 'cleanup', row_id: 'test-broken-psql', content: 'x' });
      assert.strictEqual(res.ok, false);
      assert.ok(res.error, 'error string present');
    },
  },
  {
    name: PG ? 'PG: upsert inserts then conflict-updates a real row' : 'PG: skipped (RH_TEST_PG!=1)',
    fn: () => {
      if (!PG) return;
      const db = freshScribeDb({ RH_SCRIBE_DB: '1' });
      const rid = 'test-' + Date.now().toString(36);
      // Conflict key is (bucket, source_file, row_id) since 2026-06-13; the
      // upsert only dedupes when source_file matches, so pass one (real writers
      // always do). A NULL source_file would never upsert-match (by design).
      const src = 'C:/test/upsert-cleanup.md';
      try {
        const ins = db.writeRow({ bucket: 'cleanup', row_id: rid, session_id: 'testsess', ts: '2026-06-11T00:00:00Z', content: 'first version', status: 'open', source_file: src });
        assert.strictEqual(ins.ok, true, `insert failed: ${ins.error}`);
        const upd = db.writeRow({ bucket: 'cleanup', row_id: rid, content: "second version with 'quotes' and $tags$", status: 'closed', source_file: src });
        assert.strictEqual(upd.ok, true, `update failed: ${upd.error}`);
        const sel = db.runSql(`SELECT status || '|' || content FROM scribe_rows WHERE bucket='cleanup' AND row_id=${db.dollarQuote(rid)};`);
        assert.strictEqual(sel.ok, true, `select failed: ${sel.error}`);
        assert.strictEqual(sel.stdout, "closed|second version with 'quotes' and $tags$", 'one row, updated in place (no duplicate)');
      } finally {
        db.runSql(`DELETE FROM scribe_rows WHERE row_id=${db.dollarQuote(rid)};`);
      }
    },
  },
  {
    name: PG ? 'PG: two source_file spellings of one path collapse to a single stored spelling' : 'PG: spelling-collapse skipped (RH_TEST_PG!=1)',
    fn: () => {
      if (!PG) return;
      const db = freshScribeDb({ RH_SCRIBE_DB: '1' });
      const stamp = Date.now().toString(36);
      const ridA = 'test-pd-a-' + stamp;
      const ridB = 'test-pd-b-' + stamp;
      const back = `C:\\Users\\testuser\\tmp\\parity-${stamp}\\cleanup.md`;
      const fwd = `C:/Users/testuser/tmp/parity-${stamp}/cleanup.md`;
      try {
        const a = db.writeRow({ bucket: 'cleanup', row_id: ridA, content: 'row a', status: 'open', source_file: back });
        const b = db.writeRow({ bucket: 'cleanup', row_id: ridB, content: 'row b', status: 'open', source_file: fwd });
        assert.strictEqual(a.ok, true, `insert a failed: ${a.error}`);
        assert.strictEqual(b.ok, true, `insert b failed: ${b.error}`);
        const sel = db.runSql(`SELECT count(DISTINCT source_file) FROM scribe_rows WHERE row_id IN (${db.dollarQuote(ridA)}, ${db.dollarQuote(ridB)});`);
        assert.strictEqual(sel.ok, true, `select failed: ${sel.error}`);
        assert.strictEqual(sel.stdout, '1', 'both rows share one canonical source_file spelling (no path_drift)');
        const spell = db.runSql(`SELECT DISTINCT source_file FROM scribe_rows WHERE row_id IN (${db.dollarQuote(ridA)}, ${db.dollarQuote(ridB)});`);
        assert.strictEqual(spell.stdout, fwd, 'canonical spelling is forward-slash');
      } finally {
        db.runSql(`DELETE FROM scribe_rows WHERE row_id IN (${db.dollarQuote(ridA)}, ${db.dollarQuote(ridB)});`);
      }
    },
  },
];

module.exports = { tests };

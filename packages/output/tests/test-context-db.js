// Tests for lib/context-db.js — the ctx_* "3rd write" (Phase 3.1/3.6,
// PLAN-2026-06-13-context-db.md).
//
// Unit + shape tests always run (no DB needed — the SQL builders are pure).
// Integration tests against a REAL rh_scribe database run only when
// RH_TEST_PG=1 (otherwise they report as named no-op passes).

const assert = require('assert');
const path = require('path');

const SHARED = path.join(__dirname, '..', '..', 'shared');
const LIB = path.join(__dirname, '..', 'scripts', 'lib');

function freshContextDb(env) {
  // context-db captures resolved config at require time (and pulls runSql from
  // scribe-db, which does the same), so clear both libs + both config layers.
  const prev = {};
  for (const [k, v] of Object.entries(env)) { prev[k] = process.env[k]; process.env[k] = v; }
  for (const m of [
    path.join(LIB, 'context-db.js'), path.join(LIB, 'scribe-db.js'),
    path.join(LIB, 'config.js'), path.join(SHARED, 'config.js'),
  ]) {
    delete require.cache[require.resolve(m)];
  }
  require(path.join(SHARED, 'config.js')).resetCache();
  const mod = require(path.join(LIB, 'context-db.js'));
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return mod;
}

const PG = process.env.RH_TEST_PG === '1';

const tests = [
  // ---- flag gating -------------------------------------------------------
  {
    name: 'all three writers are skipped no-ops when contextDb flag is off',
    fn: () => {
      const db = freshContextDb({ RH_CONTEXT_DB: '0' });
      assert.deepStrictEqual(
        db.upsertMemoryArtifact({ bucket: 'cleanup', row_id: 'x', source_file: 'C:/a.md' }),
        { ok: true, skipped: true });
      assert.deepStrictEqual(
        db.insertMemoryObservation({ observation: 'o', artifact_id: '00000000-0000-0000-0000-000000000000' }),
        { ok: true, skipped: true });
      assert.deepStrictEqual(
        db.logDualWrite({ entity_type: 'memory_artifact', result: 'ok' }),
        { ok: true, skipped: true });
    },
  },

  // ---- validation --------------------------------------------------------
  {
    name: 'writers reject missing required fields with an error (flag on, no DB hit)',
    fn: () => {
      const db = freshContextDb({ RH_CONTEXT_DB: '1', RH_SCRIBE_PSQL: 'Z:/nope/psql.exe' });
      const a = db.upsertMemoryArtifact({ bucket: 'cleanup', row_id: 'x' }); // no source_file
      assert.strictEqual(a.ok, false); assert.match(a.error, /source_file/);
      const o = db.insertMemoryObservation({ observation: 'o' }); // no target
      assert.strictEqual(o.ok, false); assert.match(o.error, /artifact_id|bucket/);
      const d = db.logDualWrite({ entity_type: 'x' }); // no result
      assert.strictEqual(d.ok, false); assert.match(d.error, /result/);
    },
  },
  {
    name: 'writers never throw even with a broken psql path',
    fn: () => {
      const db = freshContextDb({ RH_CONTEXT_DB: '1', RH_SCRIBE_PSQL: 'Z:/nope/psql.exe' });
      const a = db.upsertMemoryArtifact({ bucket: 'cleanup', row_id: 'x', source_file: 'C:/a.md', title: 't' });
      assert.strictEqual(a.ok, false); assert.ok(a.error, 'error string present');
    },
  },

  // ---- SQL shape (pure, no DB) ------------------------------------------
  {
    name: '_buildArtifactSql: correct table, conflict target, casts, canonical path, auto content_hash',
    fn: () => {
      const db = freshContextDb({ RH_CONTEXT_DB: '0' });
      const sql = db._buildArtifactSql({
        bucket: 'cleanup', row_id: 'r1', source_file: 'C:\\Users\\x\\cleanup.md',
        session_id_full: '00000000-0000-0000-0000-000000000001', title: 'T', body_distilled: 'B', status: 'open',
      });
      assert.match(sql, /INSERT INTO ctx_memory_artifact \(/);
      assert.match(sql, /ON CONFLICT \(bucket, source_file, row_id\) DO UPDATE SET/);
      assert.match(sql, /::uuid/, 'session_id_full cast to uuid');
      assert.ok(sql.includes('C:/Users/x/cleanup.md'), 'source_file canonicalized to forward slash');
      assert.ok(!sql.includes('C:\\Users'), 'no backslash spelling remains');
      assert.match(sql, /content_hash = EXCLUDED\.content_hash/, 'auto content_hash included + updatable');
      assert.ok(!/bucket = EXCLUDED\.bucket/.test(sql), 'natural-key columns are not in the SET clause');
      assert.match(sql, /RETURNING id;$/);
    },
  },
  {
    name: '_buildObservationSql: artifact_id path uses VALUES; natural-key path uses SELECT subquery; obs_hash defaults',
    fn: () => {
      const db = freshContextDb({ RH_CONTEXT_DB: '0' });
      const byId = db._buildObservationSql({ artifact_id: '00000000-0000-0000-0000-0000000000aa', observation: 'hello' });
      assert.match(byId, /INSERT INTO ctx_memory_observation \(artifact_id,/);
      assert.match(byId, /VALUES \(/);
      assert.match(byId, /ON CONFLICT \(artifact_id, obs_hash\) DO NOTHING/);
      // obs_hash auto-derived: sha256('hello') must appear as a quoted literal.
      assert.ok(byId.includes(db.sha256('hello')), 'obs_hash defaults to sha256(observation)');

      const byKey = db._buildObservationSql({ bucket: 'learnings', source_file: 'C:\\m\\t.md', row_id: 't', observation: 'x' });
      assert.match(byKey, /SELECT a\.id/, 'resolves artifact via subquery');
      assert.match(byKey, /FROM ctx_memory_artifact a WHERE a\.bucket = /);
      assert.ok(byKey.includes('C:/m/t.md'), 'natural-key source_file canonicalized');
    },
  },
  {
    name: '_buildDualWriteSql: correct table and canonical md_source_file',
    fn: () => {
      const db = freshContextDb({ RH_CONTEXT_DB: '0' });
      const sql = db._buildDualWriteSql({ entity_type: 'memory_artifact', result: 'ok', md_source_file: 'C:\\w\\cleanup.md', triggering_writer: 'rh-scribe-table-write' });
      assert.match(sql, /INSERT INTO ctx_dualwrite_log \(/);
      assert.ok(sql.includes('C:/w/cleanup.md'), 'md_source_file canonicalized');
    },
  },
  {
    name: 'lit: NULL/empty handling and type casts',
    fn: () => {
      const db = freshContextDb({ RH_CONTEXT_DB: '0' });
      assert.strictEqual(db.lit(null, 'text'), 'NULL');
      assert.strictEqual(db.lit(undefined, 'uuid'), 'NULL');
      assert.strictEqual(db.lit('', 'int'), 'NULL', 'empty string is NULL for typed columns');
      assert.match(db.lit('', 'text'), /^\$q[0-9a-f]{8}\$\$q[0-9a-f]{8}\$$/, 'empty string is a real empty text literal');
      assert.match(db.lit('2026-06-13T00:00:00Z', 'timestamptz'), /::timestamptz$/);
      assert.match(db.lit('42', 'int'), /::int$/);
      assert.match(db.lit('{"a":1}', 'jsonb'), /::jsonb$/);
    },
  },

  // ---- PG round-trip (RH_TEST_PG=1) -------------------------------------
  {
    name: PG ? 'PG: artifact upsert inserts then updates in place on the natural key' : 'PG: artifact upsert skipped (RH_TEST_PG!=1)',
    fn: () => {
      if (!PG) return;
      const db = freshContextDb({ RH_CONTEXT_DB: '1' });
      const stamp = Date.now().toString(36);
      const rid = 'test-ctx-' + stamp;
      const src = `C:/test/ctx-${stamp}/cleanup.md`;
      try {
        const ins = db.upsertMemoryArtifact({ bucket: 'cleanup', row_id: rid, source_file: src, title: 'first', status: 'open' });
        assert.strictEqual(ins.ok, true, `insert failed: ${ins.error}`);
        assert.ok(ins.id, 'returns the generated uuid');
        const upd = db.upsertMemoryArtifact({ bucket: 'cleanup', row_id: rid, source_file: src, title: 'second', status: 'closed' });
        assert.strictEqual(upd.ok, true, `update failed: ${upd.error}`);
        assert.strictEqual(upd.id, ins.id, 'same row (upsert on natural key), not a duplicate');
        const sel = db.runSql(`SELECT count(*) || '|' || max(title) || '|' || max(status) FROM ctx_memory_artifact WHERE row_id='${rid}';`);
        assert.strictEqual(sel.ok, true, `select failed: ${sel.error}`);
        assert.strictEqual(sel.stdout, '1|second|closed', 'one row, updated in place');
      } finally {
        db.runSql(`DELETE FROM ctx_memory_artifact WHERE row_id='${rid}';`);
      }
    },
  },
  {
    name: PG ? 'PG: observation resolves artifact by natural key and is dup-safe' : 'PG: observation skipped (RH_TEST_PG!=1)',
    fn: () => {
      if (!PG) return;
      const db = freshContextDb({ RH_CONTEXT_DB: '1' });
      const stamp = Date.now().toString(36);
      const rid = 'test-ctxobs-' + stamp;
      const src = `C:/test/ctxobs-${stamp}/learnings.md`;
      try {
        const art = db.upsertMemoryArtifact({ bucket: 'learnings', row_id: rid, source_file: src, title: 'topic' });
        assert.strictEqual(art.ok, true, `artifact insert failed: ${art.error}`);
        const o1 = db.insertMemoryObservation({ bucket: 'learnings', source_file: src, row_id: rid, observation: 'obs one', obs_date: '2026-06-13' });
        assert.strictEqual(o1.ok, true, `obs insert failed: ${o1.error}`);
        assert.strictEqual(o1.inserted, true, 'first observation inserted');
        const o2 = db.insertMemoryObservation({ bucket: 'learnings', source_file: src, row_id: rid, observation: 'obs one', obs_date: '2026-06-13' });
        assert.strictEqual(o2.ok, true, `dup obs failed: ${o2.error}`);
        assert.strictEqual(o2.inserted, false, 'identical observation is a dup-safe no-op');
        const cnt = db.runSql(`SELECT count(*) FROM ctx_memory_observation o JOIN ctx_memory_artifact a ON a.id=o.artifact_id WHERE a.row_id='${rid}';`);
        assert.strictEqual(cnt.stdout, '1', 'exactly one observation row');
      } finally {
        db.runSql(`DELETE FROM ctx_memory_artifact WHERE row_id='${rid}';`); // cascades to observations
      }
    },
  },
  {
    name: PG ? 'PG: logDualWrite appends an audit row' : 'PG: dualwrite log skipped (RH_TEST_PG!=1)',
    fn: () => {
      if (!PG) return;
      const db = freshContextDb({ RH_CONTEXT_DB: '1' });
      const stamp = Date.now().toString(36);
      const key = 'test-dw-' + stamp;
      try {
        const r = db.logDualWrite({ entity_type: 'memory_artifact', entity_natural_key: key, result: 'ok', triggering_writer: 'test', md_source_file: 'C:\\w\\cleanup.md' });
        assert.strictEqual(r.ok, true, `log failed: ${r.error}`);
        assert.ok(r.id, 'returns id');
        const sel = db.runSql(`SELECT result || '|' || md_source_file FROM ctx_dualwrite_log WHERE entity_natural_key='${key}';`);
        assert.strictEqual(sel.stdout, 'ok|C:/w/cleanup.md', 'row present with canonical path');
      } finally {
        db.runSql(`DELETE FROM ctx_dualwrite_log WHERE entity_natural_key='${key}';`);
      }
    },
  },
];

module.exports = { tests };

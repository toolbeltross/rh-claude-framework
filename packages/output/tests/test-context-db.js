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

  // ---- privacy gate (pure) ----------------------------------------------
  {
    name: 'classifyDisposition: private path -> blocklisted-skipped (incl. backslash dir spelling)',
    fn: () => {
      const db = freshContextDb({ RH_CONTEXT_DB: '0' });
      const priv = ['C:/Users/testuser/Workspace/Personal'];
      assert.strictEqual(
        db.classifyDisposition({ canonicalPath: 'C:/Users/testuser/Workspace/Personal/Financial/x.md', sourceKind: 'scribe_md' }, priv),
        'blocklisted-skipped');
      // dir given with backslashes still matches a forward-slash path
      assert.strictEqual(
        db.classifyDisposition({ canonicalPath: 'C:/Users/testuser/Workspace/Personal/x.md', sourceKind: 'scribe_md' }, ['C:\\Users\\testuser\\Workspace\\Personal']),
        'blocklisted-skipped');
      // a sibling dir that merely shares a prefix is NOT blocklisted
      assert.notStrictEqual(
        db.classifyDisposition({ canonicalPath: 'C:/Users/testuser/Workspace/PersonalNotes/x.md', sourceKind: 'scribe_md' }, priv),
        'blocklisted-skipped');
    },
  },
  {
    name: 'classifyDisposition: content scan mandatory (never slug-only) — no content is never clean',
    fn: () => {
      const db = freshContextDb({ RH_CONTEXT_DB: '0' });
      // a curated kind with NO content scanned must NOT auto-clean
      assert.strictEqual(db.classifyDisposition({ canonicalPath: 'C:/w/cleanup.md', sourceKind: 'scribe_md' }), 'review-required');
      assert.strictEqual(db.classifyDisposition({ canonicalPath: 'C:/w/t.md', sourceKind: 'learnings_md', content: '' }), 'review-required');
    },
  },
  {
    name: 'classifyDisposition: PII content -> review-required (SSN/EIN/long-acct)',
    fn: () => {
      const db = freshContextDb({ RH_CONTEXT_DB: '0' });
      assert.strictEqual(db.classifyDisposition({ canonicalPath: 'C:/w/cleanup.md', sourceKind: 'scribe_md', content: 'note SSN 123-45-6789 here' }), 'review-required');
      assert.strictEqual(db.classifyDisposition({ canonicalPath: 'C:/w/cleanup.md', sourceKind: 'scribe_md', content: 'EIN 12-3456789' }), 'review-required');
      assert.strictEqual(db.classifyDisposition({ canonicalPath: 'C:/w/cleanup.md', sourceKind: 'scribe_md', content: 'card 4111111111111111' }), 'review-required');
    },
  },
  {
    name: 'classifyDisposition: curated kind + scanned-clean content -> clean; prose logs + unknown default-deny',
    fn: () => {
      const db = freshContextDb({ RH_CONTEXT_DB: '0' });
      // curated structured kinds, content scanned + PII-clean -> clean
      for (const k of ['scribe_md', 'learnings_md', 'oversight_jsonl', 'telemetry_jsonl']) {
        assert.strictEqual(db.classifyDisposition({ canonicalPath: `C:/w/x.${k}`, sourceKind: k, content: 'benign structured row' }), 'clean', `${k} should auto-clean after scan`);
      }
      // big prose logs default-DENY even when the regex scan passes
      for (const k of ['prose_md', 'transcript_jsonl']) {
        assert.strictEqual(db.classifyDisposition({ canonicalPath: `C:/w/x.${k}`, sourceKind: k, content: 'a long benign conversation transcript with no obvious PII' }), 'review-required', `${k} should default-deny`);
      }
      // unknown kind -> review-required even with clean content
      assert.strictEqual(db.classifyDisposition({ canonicalPath: 'C:/w/whatever.md', sourceKind: 'unknown_kind', content: 'benign' }), 'review-required');
    },
  },
  {
    name: '_cleanSourceGuard + builders: source_id => EXISTS(clean/redacted) gate; no source_id => ungated',
    fn: () => {
      const db = freshContextDb({ RH_CONTEXT_DB: '0' });
      assert.strictEqual(db._cleanSourceGuard(null), '');
      const g = db._cleanSourceGuard('00000000-0000-0000-0000-0000000000ab');
      assert.match(g, /EXISTS \(SELECT 1 FROM ctx_ingest_source s WHERE s\.source_id = /);
      assert.match(g, /privacy_disposition IN \('clean','redacted'\)/);
      assert.match(g, /::uuid/);

      const gatedArt = db._buildArtifactSql({ bucket: 'cleanup', row_id: 'r', source_file: 'C:/w/c.md', source_id: '00000000-0000-0000-0000-0000000000ab', title: 't' });
      assert.match(gatedArt, /SELECT .* WHERE EXISTS \(SELECT 1 FROM ctx_ingest_source/, 'gated artifact uses SELECT..WHERE EXISTS');
      assert.ok(!/VALUES \(/.test(gatedArt), 'gated artifact does not use VALUES');

      const ungatedArt = db._buildArtifactSql({ bucket: 'cleanup', row_id: 'r', source_file: 'C:/w/c.md', title: 't' });
      assert.match(ungatedArt, /VALUES \(/, 'ungated artifact uses VALUES');

      const gatedObs = db._buildObservationSql({ bucket: 'learnings', source_file: 'C:/m/t.md', row_id: 't', observation: 'x', source_id: '00000000-0000-0000-0000-0000000000ab' });
      assert.match(gatedObs, /AND EXISTS \(SELECT 1 FROM ctx_ingest_source/, 'gated natural-key observation appends the guard');
    },
  },
  {
    name: '_buildIngestSql: correct table, conflict target, canonical path',
    fn: () => {
      const db = freshContextDb({ RH_CONTEXT_DB: '0' });
      const sql = db._buildIngestSql({ canonical_path: 'C:/w/cleanup.md', source_kind: 'scribe_md', privacy_disposition: 'clean', blocklist_version: db.BLOCKLIST_VERSION });
      assert.match(sql, /INSERT INTO ctx_ingest_source \(/);
      assert.match(sql, /ON CONFLICT \(canonical_path, source_kind\) DO UPDATE SET/);
      assert.match(sql, /last_verified_at = now\(\)/);
      assert.match(sql, /RETURNING source_id, privacy_disposition;$/);
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
    name: PG ? 'PG: privacy gate — clean source admits the content write, review-required source withholds it' : 'PG: privacy gate skipped (RH_TEST_PG!=1)',
    fn: () => {
      if (!PG) return;
      const db = freshContextDb({ RH_CONTEXT_DB: '1' });
      const stamp = Date.now().toString(36);
      const cleanPath = `C:/test/gate-clean-${stamp}/cleanup.md`;
      const dirtyPath = `C:/test/gate-dirty-${stamp}/cleanup.md`;
      const ridClean = 'test-gate-clean-' + stamp;
      const ridDirty = 'test-gate-dirty-' + stamp;
      try {
        // clean source: scribe_md, no PII -> 'clean'
        const cs = db.upsertIngestSource({ canonical_path: cleanPath, source_kind: 'scribe_md', content: 'benign note' });
        assert.strictEqual(cs.ok, true, `clean ingest failed: ${cs.error}`);
        assert.strictEqual(cs.disposition, 'clean');
        assert.ok(cs.source_id, 'clean source_id returned');
        // dirty source: PII content -> 'review-required'
        const ds = db.upsertIngestSource({ canonical_path: dirtyPath, source_kind: 'scribe_md', content: 'acct SSN 123-45-6789' });
        assert.strictEqual(ds.ok, true, `dirty ingest failed: ${ds.error}`);
        assert.strictEqual(ds.disposition, 'review-required');

        // content write against the CLEAN source is admitted
        const okWrite = db.upsertMemoryArtifact({ bucket: 'cleanup', row_id: ridClean, source_file: cleanPath, source_id: cs.source_id, title: 'allowed' });
        assert.strictEqual(okWrite.ok, true, `clean write failed: ${okWrite.error}`);
        assert.ok(okWrite.id, 'clean-source write returns an id');

        // content write against the REVIEW-REQUIRED source is withheld by the gate
        const blocked = db.upsertMemoryArtifact({ bucket: 'cleanup', row_id: ridDirty, source_file: dirtyPath, source_id: ds.source_id, title: 'should-not-land' });
        assert.strictEqual(blocked.ok, true, `blocked write errored: ${blocked.error}`);
        assert.strictEqual(blocked.gated, true, 'review-required source is gated');
        assert.ok(!blocked.id, 'no row id for a gated write');

        const cnt = db.runSql(`SELECT count(*) FROM ctx_memory_artifact WHERE row_id IN ('${ridClean}','${ridDirty}');`);
        assert.strictEqual(cnt.stdout, '1', 'exactly one artifact landed (the clean one)');
      } finally {
        db.runSql(`DELETE FROM ctx_memory_artifact WHERE row_id IN ('${ridClean}','${ridDirty}');`);
        db.runSql(`DELETE FROM ctx_ingest_source WHERE canonical_path IN ('${cleanPath}','${dirtyPath}');`);
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

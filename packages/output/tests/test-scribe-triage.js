// Tests for rh-scribe-triage.js — propose-only daily triage driver.
// Focus: C1 (robust handling of supervisor stdout) via parseProposals, which
// must never throw and must extract a JSON array from noisy output.
// PLAN-2026-06-15-scribe-disposition-ui.

const assert = require('assert');
const path = require('path');

const triage = require(path.join(__dirname, '..', 'scripts', 'rh-scribe-triage.js'));

const tests = [
  {
    name: 'parseProposals extracts a clean JSON array',
    fn: () => {
      const out = triage.parseProposals('[{"row_id":"ab12cd34","disposition":"stale"}]');
      assert.strictEqual(out.length, 1);
      assert.strictEqual(out[0].disposition, 'stale');
    },
  },
  {
    name: 'parseProposals extracts an array embedded in surrounding prose (C1)',
    fn: () => {
      const noisy = 'Here are my proposals:\n[{"row_id":"x","disposition":"still-open"}]\nDone.';
      const out = triage.parseProposals(noisy);
      assert.strictEqual(out.length, 1);
      assert.strictEqual(out[0].row_id, 'x');
    },
  },
  {
    name: 'parseProposals returns [] for empty / non-JSON / no-array output (C1, never throws)',
    fn: () => {
      assert.deepStrictEqual(triage.parseProposals(''), []);
      assert.deepStrictEqual(triage.parseProposals('Task tool not available'), []);
      assert.deepStrictEqual(triage.parseProposals('{"not":"an array"}'), []);
      assert.deepStrictEqual(triage.parseProposals('[ broken json '), []);
      assert.deepStrictEqual(triage.parseProposals(null), []);
    },
  },
  {
    name: 'buildPrompt embeds scope, today, and the rows JSON',
    fn: () => {
      const p = triage.buildPrompt([{ row_id: 'r1', bucket: 'cleanup', source_file: 'f', ts: '2026-06-01', age_days: 5, text: 't' }], '2026-06-15');
      assert.ok(p.includes('scope=scribe-triage'));
      assert.ok(p.includes('today=2026-06-15'));
      assert.ok(p.includes('"row_id":"r1"'));
    },
  },
  {
    name: 'scribeFiles lists cleanup + recommendations under the workspace root ONLY (oversightDir retired 2026-07-06)',
    fn: () => {
      const { config } = require(path.join(__dirname, '..', 'scripts', 'lib', 'config.js'));
      const files = triage.scribeFiles();
      assert.strictEqual(files.length, 2, 'exactly 2 canonical files (workspace cleanup + recommendations)');
      assert.ok(files.every(f => /\/(cleanup|recommendations)\.md$/.test(f.file)), 'only cleanup/recommendations');
      assert.ok(files.some(f => f.bucket === 'cleanup') && files.some(f => f.bucket === 'recommendations'));
      const ws = String(config.workspace).replace(/\\/g, '/');
      const ovr = String(config.oversightDir).replace(/\\/g, '/');
      assert.ok(files.every(f => f.file.startsWith(ws + '/')), 'all entries under the workspace root');
      if (ovr !== ws) {
        assert.ok(files.every(f => !f.file.startsWith(ovr + '/')), 'no oversightDir entries remain');
      }
    },
  },

  // ---- absolute-key emitter regression (PLAN-2026-08-09-absolute-key-emitter) ----
  // The defect: this script kept a private slashes-only normaliser, so after the
  // 2026-08-02 migration re-keyed the shadow to `~/…` its dedup set no longer
  // recognised rows it had already proposed. It re-walked the settled backlog at
  // BATCH_CAP/day under a second spelling — 240 duplicate rows, 6 wasted dispatches.
  {
    name: 'REGRESSION: rowKey folds the absolute and portable spellings of one file onto ONE identity',
    fn: () => {
      const pk = require(path.join(__dirname, '..', 'scripts', 'lib', 'path-key.js'));
      // Built from the live home so no machine identity is hardcoded.
      const abs = pk.homeDir().replace(/\\/g, '/') + '/Workspace/cleanup.md';
      const key = pk.toKey(abs);
      assert.strictEqual(key, '~/Workspace/cleanup.md', 'precondition: the file is under home');
      // This is the assertion the old `norm()` failed: the DB side (portable, post
      // migration) and the md side (absolute, from config.workspace) must agree.
      assert.strictEqual(
        triage.rowKey('cleanup', abs, 'ab12cd34'),
        triage.rowKey('cleanup', key, 'ab12cd34'),
        'a row already proposed under one spelling must not look untriaged under the other');
      assert.strictEqual(triage.rowKey('cleanup', abs, 'ab12cd34'), 'cleanup|~/Workspace/cleanup.md|ab12cd34');
    },
  },
  {
    name: 'POSITIVE CONTROL: rowKey still separates genuinely different rows (it is not folding everything)',
    fn: () => {
      // A check that passes for every input measures nothing. These three must all
      // stay distinct, or the test above would pass on a rowKey that returned a
      // constant.
      const a = triage.rowKey('cleanup', '~/Workspace/cleanup.md', 'r1');
      assert.notStrictEqual(a, triage.rowKey('recommendations', '~/Workspace/cleanup.md', 'r1'), 'bucket must matter');
      assert.notStrictEqual(a, triage.rowKey('cleanup', '~/Workspace/recommendations.md', 'r1'), 'file must matter');
      assert.notStrictEqual(a, triage.rowKey('cleanup', '~/Workspace/cleanup.md', 'r2'), 'row_id must matter');
      // Over-normalisation control: a path OUTSIDE home must keep its absolute form
      // rather than being faked into a portable key.
      assert.ok(triage.rowKey('cleanup', 'D:/Shared/other.md', 'r1').includes('D:/Shared/other.md'),
        'an out-of-home path must not be rewritten to ~/');
    },
  },
  {
    name: 'scribeFiles separates the filesystem path from the DB key',
    fn: () => {
      const pk = require(path.join(__dirname, '..', 'scripts', 'lib', 'path-key.js'));
      const files = triage.scribeFiles();
      for (const f of files) {
        // `file` is stat'd by scribeMd.readRows — it must stay a real absolute path.
        assert.ok(!f.file.startsWith('~'), 'file must be a real path, not a key: ' + f.file);
        assert.strictEqual(f.key, pk.toKey(f.file), 'key must be the portable form of file');
        assert.ok(!f.key.includes('\\'), 'key must be forward-slashed');
      }
    },
  },
  {
    name: 'REGRESSION: collectUntriaged emits the portable key as source_file (what writeRow stores)',
    fn: () => {
      const pk = require(path.join(__dirname, '..', 'scripts', 'lib', 'path-key.js'));
      const rows = triage.collectUntriaged();
      // May legitimately be empty (backlog drained); assert the shape of whatever is there.
      for (const r of rows) {
        assert.strictEqual(r.source_file, pk.toKey(r.source_file), 'source_file must already be a portable key');
        assert.ok(!/^[A-Za-z]:/.test(r.source_file), 'no drive-letter key may reach scribe_rows: ' + r.source_file);
      }
    },
  },
];

module.exports = { tests };

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
];

module.exports = { tests };

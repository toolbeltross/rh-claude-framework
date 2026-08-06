// Tests for lib/recall-sources.js + rh-recall.js pure helpers.
// Store-backed functions are not unit-tested here (they need a live Postgres / real
// ~/.claude); the graceful-degradation contract IS tested, because a machine without the
// oversight system must still get results from the .md files.

const assert = require('assert');
const path = require('path');

const R = require(path.join(__dirname, '..', 'scripts', 'lib', 'recall-sources.js'));
const { parseArgs } = require(path.join(__dirname, '..', 'scripts', 'rh-recall.js'));

const tests = [
  {
    name: 'terms: splits on identifier separators and drops single chars',
    fn: () => {
      assert.deepStrictEqual(R.terms('rh-transcript-ingest'), ['rh', 'transcript', 'ingest']);
      assert.deepStrictEqual(R.terms('a bb  CCC'), ['bb', 'ccc']);
      assert.deepStrictEqual(R.terms(''), []);
      assert.deepStrictEqual(R.terms(null), []);
    },
  },
  {
    name: 'relax: collapses path/identifier separators to spaces',
    fn: () => {
      assert.strictEqual(R.relax('~/.claude/memory-mcp-graph.json'), '~ claude memory mcp graph json');
      assert.strictEqual(R.relax('plain words'), 'plain words');
    },
  },
  {
    name: 'scoreText: 0 when nothing matches, higher when the title matches',
    fn: () => {
      assert.strictEqual(R.scoreText(['zebra'], 'nothing here', 'nope'), 0);
      const bodyOnly = R.scoreText(['alpha'], 'alpha appears in the body', 'unrelated');
      const titleToo = R.scoreText(['alpha'], 'alpha appears in the body', 'alpha title');
      assert.ok(titleToo > bodyOnly, 'title match should outrank body-only match');
      assert.ok(bodyOnly > 0 && titleToo <= 1, 'score stays within 0..1');
    },
  },
  {
    name: 'scoreText: partial term coverage scores below full coverage',
    fn: () => {
      const partial = R.scoreText(['alpha', 'beta'], 'only alpha here', '');
      const full = R.scoreText(['alpha', 'beta'], 'alpha and beta here', '');
      assert.ok(full > partial);
    },
  },
  {
    name: 'snippet: windows around the FIRST matching term, not the head of the text',
    fn: () => {
      const text = 'x'.repeat(400) + ' NEEDLE ' + 'y'.repeat(400);
      const s = R.snippet(text, ['needle'], 120);
      assert.ok(s.includes('NEEDLE'), 'snippet must contain the match');
      assert.ok(s.startsWith('…'), 'leading ellipsis when the window is not at the start');
    },
  },
  {
    name: 'snippet: falls back to the head when no term matches',
    fn: () => {
      const s = R.snippet('alpha beta gamma', ['zebra'], 50);
      assert.ok(s.startsWith('alpha'));
    },
  },
  {
    name: 'clip: truncates with an ellipsis and leaves short strings alone',
    fn: () => {
      assert.strictEqual(R.clip('short', 40), 'short');
      const c = R.clip('z'.repeat(100), 20);
      assert.strictEqual(c.length, 20);
      assert.ok(c.endsWith('…'));
    },
  },
  {
    name: 'available(): reports each store as a boolean (drives degradation warnings)',
    fn: () => {
      const a = R.available();
      for (const k of ['postgres', 'learnings', 'projectMemory', 'graph']) {
        assert.strictEqual(typeof a[k], 'boolean', `${k} must be a boolean`);
      }
    },
  },
  {
    name: 'DEGRADATION: Postgres-backed sources return [] rather than throwing',
    fn: () => {
      // Whatever this machine has, these must never throw — a machine without the
      // oversight system still needs recall over the .md files.
      for (const fn of [R.searchTranscripts, R.searchLogs, R.searchScribe]) {
        const out = fn('anything at all', { limit: 1 });
        assert.ok(Array.isArray(out), 'must return an array even when the store is absent');
      }
    },
  },
  {
    name: 'parseArgs: flags parsed, terms collected, limit clamped',
    fn: () => {
      const a = parseArgs(['some', 'query', '--limit', '3', '--days', '7', '--source', 'graph,learnings', '--json']);
      assert.deepStrictEqual(a.terms, ['some', 'query']);
      assert.strictEqual(a.limit, 3);
      assert.strictEqual(a.days, 7);
      assert.deepStrictEqual(a.sources, ['graph', 'learnings']);
      assert.strictEqual(a.json, true);
      assert.strictEqual(parseArgs(['q', '--limit', '999']).limit, 40, 'limit clamps to 40');
      assert.strictEqual(parseArgs(['q']).limit, 6, 'default limit');
    },
  },
];

module.exports = { tests };

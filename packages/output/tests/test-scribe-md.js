// Tests for lib/scribe-md.js — strict scribe-row parser + status mutator.
// Pure functions, always run. Covers steward conditions C2 (exactly-one
// match) and C3 (sentinel preservation). PLAN-2026-06-15-scribe-disposition-ui.

const assert = require('assert');
const path = require('path');

const md = require(path.join(__dirname, '..', 'scripts', 'lib', 'scribe-md.js'));

const FIXTURE = [
  '# Cleanup items',
  '',
  '| id | ts | session | text | status |',
  '|---|---|---|---|---|',
  '| aaaaaaaa | 2026-06-01T00:00:00Z | sess1 | first item | open |',
  '| bbbbbbbb | 2026-06-02 | sess2 | second \\| has a pipe | open |',
  '| cccccccc | 2026-06-03 | sess3 | already done | resolved |',
  '| not-a-row, prose line that mentions | open | in the middle',
  md.SENTINEL,
].join('\n');

const tests = [
  {
    name: 'parseRows returns only well-formed rows (skips header, prose, embedded pipes)',
    fn: () => {
      const rows = md.parseRows(FIXTURE);
      assert.strictEqual(rows.length, 3, 'three real rows');
      assert.deepStrictEqual(rows.map(r => r.id), ['aaaaaaaa', 'bbbbbbbb', 'cccccccc']);
    },
  },
  {
    name: 'parseLine unescapes \\| in the text cell',
    fn: () => {
      const r = md.parseLine('| bbbbbbbb | 2026-06-02 | sess2 | second \\| has a pipe | open |');
      assert.strictEqual(r.text, 'second | has a pipe');
      assert.strictEqual(r.status, 'open');
    },
  },
  {
    name: 'parseLine rejects bad id / bad ts / wrong cell count',
    fn: () => {
      assert.strictEqual(md.parseLine('| ZZZZ | 2026-06-01 | s | t | open |'), null, 'bad id');
      assert.strictEqual(md.parseLine('| aaaaaaaa | notadate | s | t | open |'), null, 'bad ts');
      assert.strictEqual(md.parseLine('| aaaaaaaa | 2026-06-01 | s | open |'), null, '4 cells');
      assert.strictEqual(md.parseLine(md.SENTINEL), null, 'sentinel');
    },
  },
  {
    name: 'C2: replaceRowStatus flips exactly one row, leaves siblings + sentinel intact',
    fn: () => {
      const r = md.replaceRowStatus(FIXTURE, 'aaaaaaaa', 'resolved: did it (2026-06-15)');
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.oldStatus, 'open');
      const rows = md.parseRows(r.content);
      const a = rows.find(x => x.id === 'aaaaaaaa');
      const b = rows.find(x => x.id === 'bbbbbbbb');
      assert.strictEqual(a.status, 'resolved: did it (2026-06-15)', 'target flipped');
      assert.strictEqual(b.status, 'open', 'sibling untouched');
      assert.strictEqual(b.text, 'second | has a pipe', 'sibling escaped pipe preserved');
      assert.strictEqual(md.countSentinels(r.content), 1, 'sentinel preserved');
    },
  },
  {
    name: 'C2: replaceRowStatus returns "row not found" for an absent id (no mutation)',
    fn: () => {
      const r = md.replaceRowStatus(FIXTURE, 'deadbeef', 'resolved');
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.error, 'row not found');
      assert.strictEqual(r.content, undefined);
    },
  },
  {
    name: 'C2: replaceRowStatus returns "ambiguous match" when an id appears twice',
    fn: () => {
      const dup = FIXTURE + '\n| aaaaaaaa | 2026-06-09 | sess9 | duplicate id | open |';
      const r = md.replaceRowStatus(dup, 'aaaaaaaa', 'resolved');
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.error, 'ambiguous match');
    },
  },
  {
    name: 'C3: a status containing a pipe is escaped, sentinel count unchanged',
    fn: () => {
      const r = md.replaceRowStatus(FIXTURE, 'bbbbbbbb', 'duplicate-of aaaaaaaa | see note');
      assert.strictEqual(r.ok, true);
      assert.strictEqual(md.countSentinels(r.content), 1);
      const b = md.parseRows(r.content).find(x => x.id === 'bbbbbbbb');
      assert.strictEqual(b.status, 'duplicate-of aaaaaaaa | see note', 'round-trips through escape');
    },
  },
];

module.exports = { tests };

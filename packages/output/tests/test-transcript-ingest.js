// Tests for rh-transcript-ingest.js pure helpers (Phase 3,
// PLAN-2026-06-11-scribe-postgres-fts.md). The end-to-end ingest path is
// outer-seam verified against the real DB (see plan); these pin the
// parsing and privacy-filter contracts.

const assert = require('assert');
const path = require('path');

const { extractMessage, slugBlocked, sqlBatchInsert } =
  require(path.join(__dirname, '..', 'scripts', 'rh-transcript-ingest.js'));

const tests = [
  {
    name: 'extractMessage: string-content user line',
    fn: () => {
      const m = extractMessage(JSON.stringify({ type: 'user', timestamp: '2026-06-11T00:00:00Z', message: { role: 'user', content: 'hello world' } }));
      assert.deepStrictEqual(m, { role: 'user', ts: '2026-06-11T00:00:00Z', text: 'hello world' });
    },
  },
  {
    name: 'extractMessage: assistant block array keeps text, drops tool_use',
    fn: () => {
      const m = extractMessage(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
        { type: 'text', text: 'part one' },
        { type: 'tool_use', name: 'Bash', input: { command: 'rm -rf SECRET' } },
        { type: 'text', text: 'part two' },
      ] } }));
      assert.strictEqual(m.text, 'part one\npart two');
      assert.ok(!m.text.includes('SECRET'));
    },
  },
  {
    name: 'extractMessage: rejects non-message lines, empty text, garbage',
    fn: () => {
      assert.strictEqual(extractMessage(JSON.stringify({ type: 'progress', data: 1 })), null);
      assert.strictEqual(extractMessage(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } })), null);
      assert.strictEqual(extractMessage('not json at all'), null);
      assert.strictEqual(extractMessage(''), null);
    },
  },
  {
    name: 'slugBlocked: blocks Personal/Financial and blocklist patterns, passes others',
    fn: () => {
      const patterns = ['personal-', 'financial-', 'personal-financial-troy2023'];
      assert.ok(slugBlocked('C--Users-x-OneDrive-Workspace-Personal-Divorce', patterns));
      assert.ok(slugBlocked('C--Users-x-OneDrive-Workspace-Personal-Financial-Troy2023', patterns));
      assert.ok(!slugBlocked('C--Users-x-OneDrive-Workspace', patterns));
      assert.ok(!slugBlocked('C--Users-x-OneDrive-Workspace-toolbeltross-rh-platform', patterns));
    },
  },
  {
    name: 'sqlBatchInsert: dollar-quoted multi-row statement, injection-proof payload',
    fn: () => {
      const sql = sqlBatchInsert('sess-1', 5, [
        { role: 'user', ts: '2026-06-11T00:00:00Z', text: "'); DROP TABLE transcripts; --" },
        { role: 'assistant', ts: null, text: 'plain' },
      ]);
      assert.ok(sql.startsWith('INSERT INTO transcript_messages'));
      assert.ok(sql.includes("'); DROP TABLE transcripts; --"), 'payload present verbatim inside dollar quotes');
      const tags = sql.match(/\$q[0-9a-f]{8}\$/g) || [];
      assert.ok(tags.length >= 8, 'all literals dollar-quoted');
      assert.ok(sql.includes(',5,') && sql.includes(',6,'), 'sequential turn numbers 5 and 6 rendered');
    },
  },
];

module.exports = { tests };

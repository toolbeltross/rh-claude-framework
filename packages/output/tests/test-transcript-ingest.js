// Tests for rh-transcript-ingest.js pure helpers (Phase 3,
// PLAN-2026-06-11-scribe-postgres-fts.md). The end-to-end ingest path is
// outer-seam verified against the real DB (see plan); these pin the
// parsing and privacy-filter contracts.

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'rh-transcript-ingest.js');
const { extractMessage, slugBlocked, sqlBatchInsert } = require(SCRIPT);
const PG = process.env.RH_TEST_PG === '1';

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
  {
    name: 'extractMessage: assistant line carries per-turn telemetry (Phase 3.5); user line does not',
    fn: () => {
      const a = extractMessage(JSON.stringify({ type: 'assistant', timestamp: '2026-06-14T08:00:00Z', message: {
        role: 'assistant', model: 'claude-opus-4-8',
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20, cache_creation_input_tokens: 10 },
        content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', name: 'Read' }],
      } }));
      assert.strictEqual(a.input_tokens, 100);
      assert.strictEqual(a.output_tokens, 50);
      assert.strictEqual(a.cache_read, 20);
      assert.strictEqual(a.cache_write, 10);
      assert.strictEqual(a.model, 'claude-opus-4-8');
      assert.strictEqual(a.tool_calls, 1);
      assert.ok(a.cost_usd > 0, 'estimated cost present');
      const u = extractMessage(JSON.stringify({ type: 'user', message: { content: 'hello' } }));
      assert.strictEqual(u.input_tokens, undefined, 'user line has no telemetry fields');
    },
  },
  {
    name: 'sqlBatchInsert: withTelemetry adds per-turn columns; default omits them',
    fn: () => {
      const msgs = [{ role: 'assistant', ts: null, text: 'x', input_tokens: 100, output_tokens: 50, cache_read: 0, cache_write: 0, cost_usd: 0.0054, tool_calls: 2 }];
      const base = sqlBatchInsert('s', 0, msgs, false);
      assert.ok(!/input_tokens/.test(base), 'no telemetry columns by default');
      const tel = sqlBatchInsert('s', 0, msgs, true);
      assert.match(tel, /INSERT INTO transcript_messages \(session_id, turn, role, ts, content, input_tokens, output_tokens, cache_read, cache_write, cost_usd, tool_calls\)/);
      assert.ok(tel.includes('0.005400'), 'cost rendered as fixed numeric literal');
      assert.ok(/,100,50,0,0,0\.005400,2\)/.test(tel), 'telemetry values rendered');
    },
  },
  {
    name: PG ? 'PG: CLI ingest with contextDb on populates per-turn columns + ctx telemetry' : 'PG: ingest telemetry skipped (RH_TEST_PG!=1)',
    fn: () => {
      if (!PG) return;
      const ctx = require(path.join(__dirname, '..', 'scripts', 'lib', 'context-db.js'));
      const sid = require('crypto').randomUUID();
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-ti-ctx-'));
      const projDir = path.join(root, 'test-proj');
      fs.mkdirSync(projDir, { recursive: true });
      const lines = [
        { type: 'user', timestamp: '2026-06-14T08:00:00Z', message: { role: 'user', content: 'hi' } },
        { type: 'assistant', timestamp: '2026-06-14T08:00:30Z', message: { role: 'assistant', model: 'claude-opus-4-8', usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [{ type: 'text', text: 'answer one' }, { type: 'tool_use', name: 'Read' }] } },
        { type: 'assistant', timestamp: '2026-06-14T08:01:00Z', message: { role: 'assistant', model: 'claude-haiku-4-5', usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [{ type: 'text', text: 'answer two' }] } },
      ].map(o => JSON.stringify(o)).join('\n') + '\n';
      fs.writeFileSync(path.join(projDir, sid + '.jsonl'), lines, 'utf8');
      try {
        const r = spawnSync('node', [SCRIPT, '--projects-dir', root, '--project', 'test-proj'], {
          encoding: 'utf8', timeout: 15000, windowsHide: true,
          env: { ...process.env, RH_SCRIBE_DB: '1', RH_CONTEXT_DB: '1' },
        });
        assert.strictEqual(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
        // per-turn columns populated on the opus assistant row
        const turn = ctx.runSql(`SELECT input_tokens || '|' || tool_calls FROM transcript_messages WHERE session_id='${sid}' AND content LIKE 'answer one%';`);
        assert.strictEqual(turn.stdout, '1000|1', 'per-turn input_tokens + tool_calls captured');
        // session snapshot + model_usage written
        const snap = ctx.runSql(`SELECT primary_model || '|' || message_count || '|' || input_tokens FROM ctx_telemetry_snapshot WHERE session_id='${sid}';`);
        assert.strictEqual(snap.stdout, 'claude-opus-4-8|2|1050', 'session snapshot aggregates both assistant turns');
        const mu = ctx.runSql(`SELECT count(*) FROM ctx_model_usage WHERE session_id='${sid}';`);
        assert.strictEqual(mu.stdout, '2', 'one model_usage row per model');
      } finally {
        ctx.runSql(`DELETE FROM transcript_messages WHERE session_id='${sid}';`);
        ctx.runSql(`DELETE FROM transcripts WHERE session_id='${sid}';`);
        ctx.runSql(`DELETE FROM ctx_model_usage WHERE session_id='${sid}';`);
        ctx.runSql(`DELETE FROM ctx_telemetry_snapshot WHERE session_id='${sid}';`);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  },
];

module.exports = { tests };

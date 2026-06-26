// Tests for lib/transcript-telemetry.js + lib/cost-rates.js — pure aggregation
// of transcript JSONL into ctx_* telemetry shapes (Phase 3.5). No DB needed.

const assert = require('assert');
const path = require('path');
const LIB = path.join(__dirname, '..', 'scripts', 'lib');
const T = require(path.join(LIB, 'transcript-telemetry.js'));
const { estimateCost, getTier } = require(path.join(LIB, 'cost-rates.js'));

function line(o) { return JSON.stringify(o); }
function asst(model, usage, content) {
  return line({ type: 'assistant', timestamp: usage._ts, message: { model, usage, content: content || [] } });
}

const tests = [
  {
    name: 'cost-rates: getTier maps model ids; estimateCost uses per-1M rates',
    fn: () => {
      assert.strictEqual(getTier('claude-opus-4-8'), 'opus');
      assert.strictEqual(getTier('claude-haiku-4-5'), 'haiku');
      assert.strictEqual(getTier('claude-sonnet-4-6'), 'sonnet');
      assert.strictEqual(getTier('mystery'), 'sonnet');
      // opus: 1M input @ $15 = $15 exactly
      assert.strictEqual(estimateCost('claude-opus-4-8', { input: 1_000_000 }), 15);
      assert.strictEqual(estimateCost('x', {}), 0);
    },
  },
  {
    name: 'parseTelemetryLine: extracts tokens/model/tool_calls/cost from a real-shape assistant line',
    fn: () => {
      const r = T.parseTelemetryLine(asst('claude-opus-4-8',
        { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20, cache_creation_input_tokens: 10, _ts: '2026-06-14T08:00:00Z' },
        [{ type: 'text', text: 'hi' }, { type: 'tool_use', name: 'Read' }, { type: 'tool_use', name: 'Bash' }]));
      assert.strictEqual(r.model, 'claude-opus-4-8');
      assert.strictEqual(r.input_tokens, 100);
      assert.strictEqual(r.output_tokens, 50);
      assert.strictEqual(r.cache_read, 20);
      assert.strictEqual(r.cache_write, 10);
      assert.strictEqual(r.tool_calls, 2, 'counts tool_use blocks only');
      assert.strictEqual(r.cost_usd, estimateCost('claude-opus-4-8', { input: 100, output: 50, cacheRead: 20, cacheWrite: 10 }));
    },
  },
  {
    name: 'parseTelemetryLine: returns null for user lines, tool-result lines, and junk',
    fn: () => {
      assert.strictEqual(T.parseTelemetryLine(line({ type: 'user', message: { content: 'hi' } })), null);
      assert.strictEqual(T.parseTelemetryLine('not json'), null);
      assert.strictEqual(T.parseTelemetryLine(line({ type: 'assistant', message: { content: [] } })), null, 'no usage + no model → null');
    },
  },
  {
    name: 'aggregateSession: folds per-model usage + snapshot totals; primary = most tokens',
    fn: () => {
      const recs = T.parseTranscriptTelemetry([
        asst('claude-opus-4-8', { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, _ts: '2026-06-14T08:00:00Z' }, [{ type: 'tool_use' }]),
        asst('claude-haiku-4-5', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, _ts: '2026-06-14T08:01:00Z' }),
        asst('claude-opus-4-8', { input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, _ts: '2026-06-14T08:02:00Z' }),
      ].join('\n'));
      const { modelUsage, snapshot } = T.aggregateSession(recs);
      assert.strictEqual(modelUsage.length, 2, 'two distinct models');
      const opus = modelUsage.find(m => m.model_id === 'claude-opus-4-8');
      assert.strictEqual(opus.input_tokens, 1500);
      assert.strictEqual(opus.message_count, 2);
      assert.strictEqual(snapshot.message_count, 3);
      assert.strictEqual(snapshot.input_tokens, 1510);
      assert.strictEqual(snapshot.tool_call_count, 1);
      assert.strictEqual(snapshot.primary_model, 'claude-opus-4-8', 'opus has more tokens');
      assert.strictEqual(snapshot.wall_ms, 120000, '2 min span');
      assert.deepStrictEqual(snapshot.model_mix, { 'claude-opus-4-8': 2, 'claude-haiku-4-5': 1 });
      assert.ok(snapshot.total_cost > 0);
    },
  },
  {
    name: 'aggregateSession: empty input → zeroed snapshot, null wall_ms, no div-by-zero',
    fn: () => {
      const { modelUsage, snapshot } = T.aggregateSession([]);
      assert.strictEqual(modelUsage.length, 0);
      assert.strictEqual(snapshot.message_count, 0);
      assert.strictEqual(snapshot.wall_ms, null);
      assert.strictEqual(snapshot.total_cost, 0);
      assert.strictEqual(snapshot.primary_model, null);
    },
  },
  {
    name: 'aggregateSubagentRun: status ok with output, orphaned without; carries totals',
    fn: () => {
      const recs = T.parseTranscriptTelemetry(asst('claude-haiku-4-5', { input_tokens: 30, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, _ts: '2026-06-14T08:00:00Z' }, [{ type: 'tool_use' }]));
      const run = T.aggregateSubagentRun(recs, { agent_id: 'agent-x', parent_session_id: 'sess', agent_type: 'Explore' });
      assert.strictEqual(run.status, 'ok');
      assert.strictEqual(run.agent_type, 'Explore');
      assert.strictEqual(run.total_tokens, 40);
      assert.strictEqual(run.primary_model, 'claude-haiku-4-5');
      const empty = T.aggregateSubagentRun([], { agent_id: 'agent-y' });
      assert.strictEqual(empty.status, 'orphaned');
    },
  },
];

module.exports = { tests };

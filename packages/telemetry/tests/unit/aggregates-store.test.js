/**
 * Tests for server/aggregates-store.js
 *
 * The aggregator parses ~/.claude/projects/<projDir>/<sessionId>.jsonl files
 * into the same shape that stats-cache.json holds. Unit-tested against a
 * tmp directory tree built per-test.
 */
import assert from 'assert';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { test, summary } from '../helpers/test-harness.js';
import { withTmp } from '../helpers/tmp.js';
import { AggregatesStore } from '../../server/aggregates-store.js';

console.log('aggregates-store tests:\n');

// ─── Fixture builder ─────────────────────────────────────────────────────────

function makeUserLine({ ts, sessionId, cwd = '/test/proj' }) {
  return JSON.stringify({
    type: 'user',
    timestamp: ts,
    sessionId,
    cwd,
    message: { role: 'user', content: 'hello' },
  });
}

function makeAssistantLine({ ts, sessionId, model = 'claude-sonnet-4-6', tokens = {}, toolUses = 0, cwd = '/test/proj' }) {
  const content = [];
  for (let i = 0; i < toolUses; i++) {
    content.push({ type: 'tool_use', id: `tu_${i}`, name: 'Read', input: {} });
  }
  content.push({ type: 'text', text: 'response' });
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    sessionId,
    cwd,
    message: {
      role: 'assistant',
      model,
      usage: {
        input_tokens: tokens.input || 0,
        output_tokens: tokens.output || 0,
        cache_read_input_tokens: tokens.cacheRead || 0,
        cache_creation_input_tokens: tokens.cacheWrite || 0,
      },
      content,
    },
  });
}

function writeSession(projectsDir, projName, sessionId, lines) {
  const projDir = join(projectsDir, projName);
  mkdirSync(projDir, { recursive: true });
  writeFileSync(join(projDir, `${sessionId}.jsonl`), lines.join('\n') + '\n');
}

// ─── empty / missing directory ───────────────────────────────────────────────

test('loadAll on missing directory yields empty aggregates', async () => {
  await withTmp(async (tmp) => {
    const store = new AggregatesStore(join(tmp, 'does-not-exist'));
    await store.loadAll();
    const agg = store.getAggregates();
    assert.strictEqual(agg.totalSessions, 0);
    assert.strictEqual(agg.totalMessages, 0);
    assert.strictEqual(agg.totalCost, 0);
    assert.deepStrictEqual(agg.dailyActivity, []);
    assert.deepStrictEqual(agg.hourCounts, {});
    assert.strictEqual(agg.firstSessionDate, null);
  }, 'aggr-empty');
});

test('loadAll on empty directory yields empty aggregates', async () => {
  await withTmp(async (tmp) => {
    const store = new AggregatesStore(tmp);
    await store.loadAll();
    assert.strictEqual(store.getAggregates().totalSessions, 0);
  }, 'aggr-empty-dir');
});

// ─── single session ──────────────────────────────────────────────────────────

test('single session: counts messages, tokens, cost', async () => {
  await withTmp(async (tmp) => {
    writeSession(tmp, 'proj-a', 's1', [
      makeUserLine({ ts: '2026-05-19T10:00:00Z', sessionId: 's1' }),
      makeAssistantLine({
        ts: '2026-05-19T10:00:01Z', sessionId: 's1',
        model: 'claude-opus-4-7',
        tokens: { input: 1_000_000, output: 0 }, // 1M opus input = $15
        toolUses: 2,
      }),
    ]);

    const store = new AggregatesStore(tmp);
    await store.loadAll();
    const agg = store.getAggregates();

    assert.strictEqual(agg.totalSessions, 1);
    assert.strictEqual(agg.totalMessages, 2); // 1 user + 1 assistant
    assert.strictEqual(agg.totalCost, 15);
    assert.strictEqual(agg.firstSessionDate, '2026-05-19T10:00:00Z');
    assert.strictEqual(agg.dailyActivity.length, 1);
    assert.strictEqual(agg.dailyActivity[0].date, '2026-05-19');
    assert.strictEqual(agg.dailyActivity[0].messageCount, 2);
    assert.strictEqual(agg.dailyActivity[0].sessionCount, 1);
    assert.strictEqual(agg.dailyActivity[0].toolCallCount, 2);
    assert.ok(agg.modelUsage['claude-opus-4-7'], 'modelUsage records opus model');
    assert.strictEqual(agg.modelUsage['claude-opus-4-7'].input, 1_000_000);
    assert.strictEqual(agg.modelUsage['claude-opus-4-7'].cost, 15);
  }, 'aggr-single');
});

// ─── multi-session, multi-day, multi-model ───────────────────────────────────

test('multi-day across multiple sessions', async () => {
  await withTmp(async (tmp) => {
    writeSession(tmp, 'proj-a', 's1', [
      makeAssistantLine({
        ts: '2026-05-17T08:00:00Z', sessionId: 's1',
        model: 'claude-sonnet-4-6',
        tokens: { input: 1_000_000 }, // $3
      }),
    ]);
    writeSession(tmp, 'proj-a', 's2', [
      makeAssistantLine({
        ts: '2026-05-18T14:30:00Z', sessionId: 's2',
        model: 'claude-haiku-4-5',
        tokens: { input: 1_000_000 }, // $0.80
      }),
    ]);
    writeSession(tmp, 'proj-b', 's3', [
      makeAssistantLine({
        ts: '2026-05-18T22:00:00Z', sessionId: 's3',
        model: 'claude-sonnet-4-6',
        tokens: { input: 2_000_000 }, // $6
      }),
    ]);

    const store = new AggregatesStore(tmp);
    await store.loadAll();
    const agg = store.getAggregates();

    assert.strictEqual(agg.totalSessions, 3);
    assert.strictEqual(agg.firstSessionDate, '2026-05-17T08:00:00Z');

    // Daily breakdown
    assert.strictEqual(agg.dailyActivity.length, 2, 'two distinct dates');
    const dayMap = Object.fromEntries(agg.dailyActivity.map((d) => [d.date, d]));
    assert.strictEqual(dayMap['2026-05-17'].sessionCount, 1);
    assert.strictEqual(dayMap['2026-05-18'].sessionCount, 2);

    // Model breakdown
    assert.ok(agg.modelUsage['claude-sonnet-4-6']);
    assert.ok(agg.modelUsage['claude-haiku-4-5']);
    assert.strictEqual(agg.modelUsage['claude-sonnet-4-6'].input, 3_000_000);
    // Total cost = $3 + $0.80 + $6 = $9.80
    assert.ok(Math.abs(agg.totalCost - 9.8) < 0.01, `expected ~9.80, got ${agg.totalCost}`);

    // Hourly counts: hours 8, 14, 22 each appear once
    assert.strictEqual(agg.hourCounts[8], 1);
    assert.strictEqual(agg.hourCounts[14], 1);
    assert.strictEqual(agg.hourCounts[22], 1);
  }, 'aggr-multi');
});

// ─── corrupt lines are skipped, not fatal ────────────────────────────────────

test('corrupt JSON lines are skipped', async () => {
  await withTmp(async (tmp) => {
    writeSession(tmp, 'proj', 's1', [
      makeUserLine({ ts: '2026-05-19T10:00:00Z', sessionId: 's1' }),
      'this is not JSON',
      makeAssistantLine({ ts: '2026-05-19T10:00:01Z', sessionId: 's1', tokens: { input: 100 } }),
      '{"broken":',
    ]);
    const store = new AggregatesStore(tmp);
    await store.loadAll();
    const agg = store.getAggregates();
    assert.strictEqual(agg.totalSessions, 1);
    assert.strictEqual(agg.totalMessages, 2); // user + assistant (corrupt lines skipped)
  }, 'aggr-corrupt');
});

// ─── longestSession picks the right one ──────────────────────────────────────

test('longestSession identifies the session with max duration', async () => {
  await withTmp(async (tmp) => {
    writeSession(tmp, 'proj', 'short', [
      makeAssistantLine({ ts: '2026-05-19T10:00:00Z', sessionId: 'short' }),
      makeAssistantLine({ ts: '2026-05-19T10:01:00Z', sessionId: 'short' }), // 1 min
    ]);
    writeSession(tmp, 'proj', 'long', [
      makeAssistantLine({ ts: '2026-05-19T08:00:00Z', sessionId: 'long' }),
      makeAssistantLine({ ts: '2026-05-19T10:00:00Z', sessionId: 'long' }), // 2 hr
    ]);
    const store = new AggregatesStore(tmp);
    await store.loadAll();
    const agg = store.getAggregates();
    assert.strictEqual(agg.longestSession.sessionId, 'long');
    assert.strictEqual(agg.longestSession.durationMs, 2 * 60 * 60 * 1000);
  }, 'aggr-longest');
});

// ─── reloadSession (incremental update) ──────────────────────────────────────

test('reloadSession picks up new transcript content', async () => {
  await withTmp(async (tmp) => {
    writeSession(tmp, 'proj', 's1', [
      makeAssistantLine({ ts: '2026-05-19T10:00:00Z', sessionId: 's1', tokens: { input: 1000 } }),
    ]);
    const store = new AggregatesStore(tmp);
    await store.loadAll();
    assert.strictEqual(store.getAggregates().totalMessages, 1);

    // Simulate Claude Code appending another assistant turn
    writeSession(tmp, 'proj', 's1', [
      makeAssistantLine({ ts: '2026-05-19T10:00:00Z', sessionId: 's1', tokens: { input: 1000 } }),
      makeAssistantLine({ ts: '2026-05-19T10:00:30Z', sessionId: 's1', tokens: { input: 2000 } }),
    ]);
    await store.reloadSession('s1', join(tmp, 'proj', 's1.jsonl'));
    assert.strictEqual(store.getAggregates().totalMessages, 2);
  }, 'aggr-reload');
});

// ─── update event fires ──────────────────────────────────────────────────────

test('loadAll fires "update" event', async () => {
  await withTmp(async (tmp) => {
    writeSession(tmp, 'proj', 's1', [
      makeAssistantLine({ ts: '2026-05-19T10:00:00Z', sessionId: 's1' }),
    ]);
    const store = new AggregatesStore(tmp);
    let fired = false;
    store.once('update', () => { fired = true; });
    await store.loadAll();
    assert.strictEqual(fired, true);
  }, 'aggr-event');
});

summary();

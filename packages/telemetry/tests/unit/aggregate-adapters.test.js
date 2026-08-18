/**
 * Tests for src/lib/aggregate-adapters.js
 *
 * These adapters let the v1 Overview surface fall back to the live transcript
 * aggregator when Claude Code's own stats-cache.json / .claude.json `last*`
 * data is missing. The contract that matters is SHAPE COMPATIBILITY with
 * server/parser.js — Overview and SessionTab read parser field names, so a
 * silent key mismatch renders a blank card or, worse, a wrong number.
 */
import assert from 'assert';
import { test, summary } from '../helpers/test-harness.js';
import {
  adaptAggregates,
  adaptAggregateSessions,
  friendlyModelName,
  formatDuration,
} from '../../src/lib/aggregate-adapters.js';

console.log('aggregate-adapters tests:\n');

// ─── adaptAggregates ──────────────────────────────────────────────────────

test('adaptAggregates: null input yields null (parser returns null too)', () => {
  assert.strictEqual(adaptAggregates(null), null);
  assert.strictEqual(adaptAggregates(undefined), null);
});

test('adaptAggregates: renames modelUsage input/output to inputTokens/outputTokens', () => {
  // This is the whole reason the adapter exists. The aggregator emits
  // `input`/`output`; OverviewTab's Total Tokens card reads
  // `inputTokens`/`outputTokens`. Without the rename it sums to 0 and the
  // card falls through to a cache-inclusive figure — wrong, not blank.
  const out = adaptAggregates({
    modelUsage: {
      'claude-opus-5': { input: 100, output: 200, cacheRead: 5, cacheWrite: 7, cost: 1.5 },
    },
  });
  const m = out.modelUsage['claude-opus-5'];
  assert.strictEqual(m.inputTokens, 100);
  assert.strictEqual(m.outputTokens, 200);
  // original keys preserved — nothing removed, per the additive-only rule
  assert.strictEqual(m.input, 100);
  assert.strictEqual(m.cacheRead, 5);
  assert.strictEqual(m.cost, 1.5);
});

test('adaptAggregates: Total Tokens sums to input+output, excluding cache', () => {
  const out = adaptAggregates({
    modelUsage: {
      a: { input: 10, output: 20, cacheRead: 1_000_000, cacheWrite: 500_000 },
      b: { input: 5, output: 15, cacheRead: 9_000_000, cacheWrite: 0 },
    },
  });
  // Mirrors the reduce in OverviewTab
  const total = Object.values(out.modelUsage).reduce(
    (sum, m) => sum + (m.inputTokens || 0) + (m.outputTokens || 0),
    0
  );
  assert.strictEqual(total, 50);
});

test('adaptAggregates: passes chart fields through untouched', () => {
  const daily = [{ date: '2026-07-20', messageCount: 179, sessionCount: 3, toolCallCount: 43 }];
  const dailyTokens = [{ date: '2026-07-20', tokensByModel: { 'claude-opus-4-8': 20713057 } }];
  const hours = { 0: 6, 1: 3, 23: 9 };
  const out = adaptAggregates({
    dailyActivity: daily,
    dailyModelTokens: dailyTokens,
    hourCounts: hours,
    totalSessions: 52,
    totalMessages: 26041,
    firstSessionDate: '2026-07-20T20:01:11.267Z',
  });
  assert.deepStrictEqual(out.dailyActivity, daily);
  assert.deepStrictEqual(out.dailyModelTokens, dailyTokens);
  assert.deepStrictEqual(out.hourCounts, hours);
  assert.strictEqual(out.totalSessions, 52);
  assert.strictEqual(out.totalMessages, 26041);
  assert.strictEqual(out.firstSessionDate, '2026-07-20T20:01:11.267Z');
});

test('adaptAggregates: missing fields default rather than throwing', () => {
  const out = adaptAggregates({});
  assert.deepStrictEqual(out.dailyActivity, []);
  assert.deepStrictEqual(out.modelUsage, {});
  assert.strictEqual(out.totalSessions, 0);
  assert.strictEqual(out.firstSessionDate, null);
});

// ─── adaptAggregateSessions ───────────────────────────────────────────────

const SAMPLE = {
  sessionId: 'fd219cee-70f1-4baf-851c-32775b535f7f',
  // Fixture paths deliberately avoid any home-directory shape. packages/cli's
  // test-no-identity-refs.js greps all of packages/ for user-home path patterns
  // and this repo is public, so even a placeholder home path fails that check.
  projectDir: 'D--work-proj',
  projectPath: 'D:\\work\\projects\\rh-connection-graph',
  lastTs: '2026-08-15T03:43:50.301Z',
  durationMs: 298817,
  messageCount: 628,
  toolCallCount: 224,
  totalCost: 253.4645,
  models: { 'claude-opus-5': { input: 6647, output: 477678, cacheRead: 81266379, cacheWrite: 5100768 } },
  primaryModel: 'claude-opus-5',
};

test('adaptAggregateSessions: non-array input yields empty array', () => {
  assert.deepStrictEqual(adaptAggregateSessions(null), []);
  assert.deepStrictEqual(adaptAggregateSessions(undefined), []);
  assert.deepStrictEqual(adaptAggregateSessions({}), []);
});

test('adaptAggregateSessions: emits every field parser.js emits', () => {
  // SessionTab receives this object verbatim when a Recent Sessions row is
  // clicked, so a missing key renders a blank panel rather than an error.
  const [s] = adaptAggregateSessions([SAMPLE]);
  for (const key of [
    'sessionId', 'projectPath', 'projectName', 'cost', 'duration', 'durationMs',
    'primaryModel', 'primaryModelId', 'models', 'tokens', 'linesAdded',
    'linesRemoved', 'fps', 'performance', 'apiDuration', 'toolDuration', 'lastActiveTs',
  ]) {
    assert.ok(key in s, `missing key: ${key}`);
  }
});

test('adaptAggregateSessions: derives projectName from a Windows path', () => {
  const [s] = adaptAggregateSessions([SAMPLE]);
  assert.strictEqual(s.projectName, 'rh-connection-graph');
});

test('adaptAggregateSessions: derives projectName from a POSIX path', () => {
  const [s] = adaptAggregateSessions([{ ...SAMPLE, projectPath: '/srv/work/rh-leafletmap' }]);
  assert.strictEqual(s.projectName, 'rh-leafletmap');
});

test('adaptAggregateSessions: tokens.total includes cache, matching parser.js', () => {
  const [s] = adaptAggregateSessions([SAMPLE]);
  assert.strictEqual(s.tokens.input, 6647);
  assert.strictEqual(s.tokens.output, 477678);
  assert.strictEqual(s.tokens.cacheRead, 81266379);
  assert.strictEqual(s.tokens.cacheWrite, 5100768);
  assert.strictEqual(s.tokens.total, 6647 + 477678 + 81266379 + 5100768);
});

test('adaptAggregateSessions: models[] carries a non-zero derived cost', () => {
  // Per-model cost is not in /api/sessions; it is derived with the same
  // estimateCost the server uses, so ModelBreakdown has something to plot.
  const [s] = adaptAggregateSessions([SAMPLE]);
  assert.strictEqual(s.models.length, 1);
  assert.strictEqual(s.models[0].id, 'claude-opus-5');
  assert.strictEqual(s.models[0].name, 'Opus 5');
  assert.ok(s.models[0].cost > 0, 'expected a derived per-model cost');
  assert.strictEqual(s.models[0].inputTokens, 6647);
});

test('adaptAggregateSessions: session cost is the aggregator total, not the estimate', () => {
  // totalCost is authoritative; the per-model figure is only for the donut.
  const [s] = adaptAggregateSessions([SAMPLE]);
  assert.strictEqual(s.cost, 253.4645);
});

test('adaptAggregateSessions: empty models map does not throw', () => {
  const [s] = adaptAggregateSessions([{ ...SAMPLE, models: {}, primaryModel: null }]);
  assert.deepStrictEqual(s.models, []);
  assert.strictEqual(s.tokens.total, 0);
  assert.strictEqual(s.primaryModel, 'unknown');
});

test('adaptAggregateSessions: tags rows with _source so origin stays visible', () => {
  const [s] = adaptAggregateSessions([SAMPLE]);
  assert.strictEqual(s._source, 'aggregator');
});

// ─── helpers ──────────────────────────────────────────────────────────────

test('friendlyModelName: matches server/parser.js behavior', () => {
  assert.strictEqual(friendlyModelName('claude-opus-5'), 'Opus 5');
  assert.strictEqual(friendlyModelName('claude-sonnet-4-6-20250514'), 'Sonnet 4.6');
  assert.strictEqual(friendlyModelName('claude-haiku-4-5'), 'Haiku 4.5');
  assert.strictEqual(friendlyModelName('some-opus-thing'), 'Opus');
  assert.strictEqual(friendlyModelName(''), 'unknown');
  assert.strictEqual(friendlyModelName(null), 'unknown');
});

test('formatDuration: matches server/parser.js behavior', () => {
  assert.strictEqual(formatDuration(0), '0s');
  assert.strictEqual(formatDuration(null), '0s');
  assert.strictEqual(formatDuration(45_000), '45s');
  assert.strictEqual(formatDuration(298_817), '4m 58s');
  assert.strictEqual(formatDuration(3_900_000), '1h 5m');
});

summary();

// ─── contextTokens passthrough (end-of-session context fill) ──────────────

test('adaptAggregateSessions: carries lastContextTokens through as contextTokens', () => {
  const [s] = adaptAggregateSessions([{ ...SAMPLE, lastContextTokens: 383_000 }]);
  assert.strictEqual(s.contextTokens, 383_000);
});

test('adaptAggregateSessions: missing lastContextTokens yields 0, not undefined', () => {
  // 0 is falsy, which the gauge treats as "no measurement" and renders "?".
  // undefined would silently become NaN downstream.
  const [s] = adaptAggregateSessions([SAMPLE]);
  assert.strictEqual(s.contextTokens, 0);
});

test('adaptAggregateSessions: contextTokens is independent of the cumulative sums', () => {
  // The whole point: tokens.total runs to ~87M on this fixture while the real
  // end-of-session context was 383K. Conflating them is the bug this prevents.
  const [s] = adaptAggregateSessions([{ ...SAMPLE, lastContextTokens: 383_000 }]);
  assert.ok(s.tokens.total > 80_000_000, 'fixture should have huge cumulative total');
  assert.strictEqual(s.contextTokens, 383_000);
  assert.ok(s.contextTokens < s.tokens.total / 100);
});

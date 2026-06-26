/**
 * Tests for server/cost-rates.js
 */
import assert from 'assert';
import { test, summary } from '../helpers/test-harness.js';
import { MODEL_RATES, getTier, estimateCost } from '../../server/cost-rates.js';

console.log('cost-rates tests:\n');

// --- MODEL_RATES shape ---
test('MODEL_RATES has opus, sonnet, haiku tiers', () => {
  assert.ok(MODEL_RATES.opus);
  assert.ok(MODEL_RATES.sonnet);
  assert.ok(MODEL_RATES.haiku);
});

test('each tier has input/output/cacheRead/cacheWrite', () => {
  for (const tier of ['opus', 'sonnet', 'haiku']) {
    const r = MODEL_RATES[tier];
    assert.strictEqual(typeof r.input, 'number');
    assert.strictEqual(typeof r.output, 'number');
    assert.strictEqual(typeof r.cacheRead, 'number');
    assert.strictEqual(typeof r.cacheWrite, 'number');
  }
});

test('opus is more expensive than sonnet which is more expensive than haiku', () => {
  assert.ok(MODEL_RATES.opus.input > MODEL_RATES.sonnet.input);
  assert.ok(MODEL_RATES.sonnet.input > MODEL_RATES.haiku.input);
});

// --- getTier ---
test('getTier: opus model id', () => {
  assert.strictEqual(getTier('claude-opus-4-6'), 'opus');
});

test('getTier: sonnet model id', () => {
  assert.strictEqual(getTier('claude-sonnet-4-6'), 'sonnet');
});

test('getTier: haiku model id', () => {
  assert.strictEqual(getTier('claude-haiku-4-5-20251001'), 'haiku');
});

test('getTier: display name with capitals', () => {
  assert.strictEqual(getTier('Opus 4.6'), 'opus');
  assert.strictEqual(getTier('Sonnet 4.6'), 'sonnet');
  assert.strictEqual(getTier('Haiku 4.5'), 'haiku');
});

test('getTier: unknown defaults to sonnet', () => {
  assert.strictEqual(getTier('gpt-4'), 'sonnet');
  assert.strictEqual(getTier(''), 'sonnet');
  assert.strictEqual(getTier(null), 'sonnet');
  assert.strictEqual(getTier(undefined), 'sonnet');
});

// --- estimateCost ---
test('estimateCost: zero tokens → zero cost', () => {
  assert.strictEqual(estimateCost('claude-opus-4-6', {}), 0);
  assert.strictEqual(estimateCost('claude-opus-4-6', { input: 0, output: 0 }), 0);
});

test('estimateCost: 1M opus input tokens = $15', () => {
  const cost = estimateCost('claude-opus-4-6', { input: 1_000_000 });
  assert.strictEqual(cost, 15);
});

test('estimateCost: mixed tokens sum correctly', () => {
  // 100k opus input = 100/1000 * 15 = 1.5
  // 10k opus output = 10/1000 * 75 = 0.75
  // Total = 2.25
  const cost = estimateCost('claude-opus-4-6', { input: 100_000, output: 10_000 });
  assert.ok(Math.abs(cost - 2.25) < 0.001, `expected ~2.25, got ${cost}`);
});

test('estimateCost: cache read is much cheaper than fresh input', () => {
  const fresh = estimateCost('claude-opus-4-6', { input: 1_000_000 });
  const cached = estimateCost('claude-opus-4-6', { cacheRead: 1_000_000 });
  assert.ok(cached < fresh / 5, 'cache read should be at least 5× cheaper than fresh input');
});

test('estimateCost: unknown model uses sonnet rates', () => {
  const unknown = estimateCost('gpt-4', { input: 1_000_000 });
  const sonnet = estimateCost('claude-sonnet-4-6', { input: 1_000_000 });
  assert.strictEqual(unknown, sonnet);
});

summary();

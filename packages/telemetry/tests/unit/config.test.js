/**
 * Tests for server/config.js — specifically resolveContextWindowSize,
 * which is load-bearing for all extended-context detection across the
 * server, CLI, and hook-forwarder transcript-parse path.
 */
import assert from 'assert';
import { test, summary } from '../helpers/test-harness.js';
import { resolveContextWindowSize, EXTENDED_CONTEXT_WINDOW_SIZE, DEFAULT_CONTEXT_WINDOW_SIZE } from '../../server/config.js';

const _savedCtxEnv = process.env.CLAUDE_CONTEXT_WINDOW_SIZE;
delete process.env.CLAUDE_CONTEXT_WINDOW_SIZE;
process.on('exit', () => {
  if (_savedCtxEnv !== undefined) process.env.CLAUDE_CONTEXT_WINDOW_SIZE = _savedCtxEnv;
});

console.log('config tests:\n');

test('resolveContextWindowSize: 1M model name match returns 1M', () => {
  const size = resolveContextWindowSize(200000, 'Opus 4.6 (1M context)', 50000);
  assert.strictEqual(size, EXTENDED_CONTEXT_WINDOW_SIZE);
});

test('resolveContextWindowSize: 1M name match is case-insensitive', () => {
  const size = resolveContextWindowSize(200000, 'Sonnet 4.6 (1m Context)', 0);
  assert.strictEqual(size, EXTENDED_CONTEXT_WINDOW_SIZE);
});

test('resolveContextWindowSize: token overshoot triggers 1M auto-detect', () => {
  // Forwarder transcript-parse path relies on this: when display name is
  // generic ("Opus") but tokens exceed the reported 200k window, we must
  // infer a larger real window rather than capping fillPct at 100%.
  const size = resolveContextWindowSize(200000, 'Opus', 284918);
  assert.strictEqual(size, EXTENDED_CONTEXT_WINDOW_SIZE);
});

test('resolveContextWindowSize: under-threshold returns reported size', () => {
  const size = resolveContextWindowSize(200000, 'Opus 4.6', 50000);
  assert.strictEqual(size, 200000);
});

test('resolveContextWindowSize: null reportedSize returns null', () => {
  const size = resolveContextWindowSize(null, 'Opus', 0);
  assert.strictEqual(size, null);
});

test('resolveContextWindowSize: null modelName with under-threshold tokens returns reported', () => {
  const size = resolveContextWindowSize(200000, null, 50000);
  assert.strictEqual(size, 200000);
});

test('resolveContextWindowSize: null modelName with overshoot still detects 1M', () => {
  // The forwarder used to pass null for modelDisplayName. Even with null,
  // the token-overshoot branch must still fire. Regression guard.
  const size = resolveContextWindowSize(200000, null, 500000);
  assert.strictEqual(size, EXTENDED_CONTEXT_WINDOW_SIZE);
});

test('resolveContextWindowSize: env override wins over everything', () => {
  const prev = process.env.CLAUDE_CONTEXT_WINDOW_SIZE;
  process.env.CLAUDE_CONTEXT_WINDOW_SIZE = '500000';
  try {
    const size = resolveContextWindowSize(200000, 'Opus 4.6 (1M context)', 1);
    assert.strictEqual(size, 500000);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONTEXT_WINDOW_SIZE;
    else process.env.CLAUDE_CONTEXT_WINDOW_SIZE = prev;
  }
});

test('DEFAULT_CONTEXT_WINDOW_SIZE is 200k', () => {
  assert.strictEqual(DEFAULT_CONTEXT_WINDOW_SIZE, 200_000);
});

test('EXTENDED_CONTEXT_WINDOW_SIZE is 1M', () => {
  assert.strictEqual(EXTENDED_CONTEXT_WINDOW_SIZE, 1_000_000);
});

summary();

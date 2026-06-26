/**
 * Tests for server/failure-alerting.js
 */
import assert from 'assert';
import { test, summary } from '../helpers/test-harness.js';
import { FailureAlerter } from '../../server/failure-alerting.js';

console.log('failure-alerter tests:\n');

test('check: under threshold returns null', () => {
  const a = new FailureAlerter(3, 60_000);
  assert.strictEqual(a.check('s1', 'Read'), null);
  assert.strictEqual(a.check('s1', 'Read'), null);
});

test('check: third failure triggers alert', () => {
  const a = new FailureAlerter(3, 60_000);
  a.check('s1', 'Read');
  a.check('s1', 'Read');
  const alert = a.check('s1', 'Read');
  assert.ok(alert);
  assert.strictEqual(alert.alert, true);
  assert.strictEqual(alert.count, 3);
  assert.strictEqual(alert.toolName, 'Read');
  assert.strictEqual(alert.sessionId, 's1');
});

test('check: alert keeps firing past threshold', () => {
  const a = new FailureAlerter(3, 60_000);
  for (let i = 0; i < 3; i++) a.check('s1', 'Read');
  const alert = a.check('s1', 'Read');
  assert.ok(alert);
  assert.strictEqual(alert.count, 4);
});

test('check: failures outside the window are pruned', () => {
  const a = new FailureAlerter(3, 60_000);
  const now = 1_000_000_000;
  a.check('s1', 'Read', now);
  a.check('s1', 'Read', now);
  // 70s later — first two are outside the 60s window
  const alert = a.check('s1', 'Read', now + 70_000);
  assert.strictEqual(alert, null, 'window expired, should not alert from old entries');
});

test('check: different sessions tracked independently', () => {
  const a = new FailureAlerter(3, 60_000);
  a.check('s1', 'Read');
  a.check('s1', 'Read');
  // s2 has fresh count
  const result = a.check('s2', 'Read');
  assert.strictEqual(result, null, 's2 should be at count 1');
});

test('check: different tools tracked independently', () => {
  const a = new FailureAlerter(3, 60_000);
  a.check('s1', 'Read');
  a.check('s1', 'Read');
  // Bash is a different key
  const result = a.check('s1', 'Bash');
  assert.strictEqual(result, null, 'Bash should be at count 1 even though Read is at 2');
});

test('getConfig returns threshold and window', () => {
  const a = new FailureAlerter(5, 30_000);
  const cfg = a.getConfig();
  assert.strictEqual(cfg.threshold, 5);
  assert.strictEqual(cfg.windowMs, 30_000);
});

test('default constructor uses config values', () => {
  const a = new FailureAlerter();
  const cfg = a.getConfig();
  assert.ok(cfg.threshold > 0);
  assert.ok(cfg.windowMs > 0);
});

summary();

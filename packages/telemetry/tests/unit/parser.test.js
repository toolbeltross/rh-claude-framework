/**
 * Tests for server/parser.js — currently covers exported pure helpers.
 * Full session parsing is exercised by integration tests via the live server.
 */
import assert from 'assert';
import { test, summary } from '../helpers/test-harness.js';
import { friendlyModelName } from '../../server/parser.js';

console.log('parser tests:\n');

test('friendlyModelName: opus 4-6', () => {
  assert.strictEqual(friendlyModelName('claude-opus-4-6'), 'Opus 4.6');
});

test('friendlyModelName: sonnet with date suffix', () => {
  // Regex captures "4-6", strips date
  const result = friendlyModelName('claude-sonnet-4-6-20250514');
  assert.ok(result.startsWith('Sonnet'));
  assert.ok(result.includes('4'));
});

test('friendlyModelName: haiku 4-5', () => {
  assert.strictEqual(friendlyModelName('claude-haiku-4-5'), 'Haiku 4.5');
});

test('friendlyModelName: family-only fallback', () => {
  assert.strictEqual(friendlyModelName('opus-experimental'), 'Opus');
  assert.strictEqual(friendlyModelName('sonnet-beta'), 'Sonnet');
});

test('friendlyModelName: unknown returns original', () => {
  assert.strictEqual(friendlyModelName('gpt-4'), 'gpt-4');
});

test('friendlyModelName: null/empty returns "unknown"', () => {
  assert.strictEqual(friendlyModelName(null), 'unknown');
  assert.strictEqual(friendlyModelName(''), 'unknown');
  assert.strictEqual(friendlyModelName(undefined), 'unknown');
});

summary();

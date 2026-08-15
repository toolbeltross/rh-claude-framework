/**
 * Tests for getContextLimit() in src/components/ContextWindow.jsx
 *
 * This function resolves the context-window size for a FILE-based session,
 * which has no statusLine payload to report one. It previously matched a
 * hardcoded table keyed on `claude-opus-4` / `claude-sonnet-4` / `claude-haiku-4`
 * — generation-locked, so every Claude 5 session fell through to null and the
 * gauge showed "?" with no size and no percentage.
 *
 * The regression these tests exist to prevent is a NEW generation locking the
 * table again, and the opposite failure: assuming 1M from a model id. Measured
 * 2026-08-15, `claude-opus-5` sessions reported both 200K and 1M depending on
 * usage, so the id alone does not determine the window — 1M is concluded only
 * from an explicit marker or from a context fill that exceeds the base window.
 */
import assert from 'assert';
import { test, summary } from '../helpers/test-harness.js';
import { getContextLimit } from '../../src/lib/context-limit.js';

console.log('getContextLimit tests:\n');

const BASE = 200_000;
const EXTENDED = 1_000_000;

test('returns null for a missing model id rather than guessing', () => {
  assert.strictEqual(getContextLimit(null), null);
  assert.strictEqual(getContextLimit(''), null);
  assert.strictEqual(getContextLimit(undefined), null);
});

test('THE REGRESSION: resolves Claude 5 ids, which the old table missed', () => {
  assert.strictEqual(getContextLimit('claude-opus-5'), BASE);
  assert.strictEqual(getContextLimit('claude-sonnet-5'), BASE);
  assert.strictEqual(getContextLimit('claude-haiku-5'), BASE);
});

test('still resolves the Claude 4 ids the old table handled', () => {
  assert.strictEqual(getContextLimit('claude-opus-4'), BASE);
  assert.strictEqual(getContextLimit('claude-opus-4-8'), BASE);
  assert.strictEqual(getContextLimit('claude-sonnet-4-6-20250514'), BASE);
  assert.strictEqual(getContextLimit('claude-haiku-4-5-20251001'), BASE);
});

test('is generation-agnostic — a future release must not silently fall through', () => {
  // The whole point of matching on family rather than family+generation.
  assert.strictEqual(getContextLimit('claude-opus-6'), BASE);
  assert.strictEqual(getContextLimit('claude-sonnet-9-2-20301231'), BASE);
});

test('honours the [1m] bracket marker', () => {
  assert.strictEqual(getContextLimit('claude-opus-4-7[1m]'), EXTENDED);
  assert.strictEqual(getContextLimit('claude-sonnet-5[1m]'), EXTENDED);
});

test('honours the "1M context" display-name phrasing', () => {
  assert.strictEqual(getContextLimit('Opus 4.6 (1M context)'), EXTENDED);
  assert.strictEqual(getContextLimit('claude-opus-5 1m context'), EXTENDED);
});

test('does NOT assume 1M from the model id alone', () => {
  // Measured: concurrent claude-opus-5 sessions reported 200K and 1M. Inferring
  // the window from the id would be inventing a number for half of them.
  assert.strictEqual(getContextLimit('claude-opus-5'), BASE);
  assert.strictEqual(getContextLimit('claude-opus-5', 0), BASE);
  assert.strictEqual(getContextLimit('claude-opus-5', 150_000), BASE);
});

test('overshoot rule: context above the base window proves a larger one', () => {
  // Evidence, not assumption — a session cannot hold 383K in a 200K window.
  assert.strictEqual(getContextLimit('claude-opus-5', 383_000), EXTENDED);
  assert.strictEqual(getContextLimit('claude-sonnet-4-6', 250_000), EXTENDED);
});

test('overshoot boundary is exclusive at exactly the base size', () => {
  assert.strictEqual(getContextLimit('claude-opus-5', BASE), BASE);
  assert.strictEqual(getContextLimit('claude-opus-5', BASE + 1), EXTENDED);
});

test('returns null for a non-Claude id instead of defaulting', () => {
  // "unknown" is what parser.js emits when .claude.json has no model usage.
  // Defaulting it to 200K would attach a real-looking window to a session we
  // know nothing about.
  assert.strictEqual(getContextLimit('unknown'), null);
  assert.strictEqual(getContextLimit('gpt-4'), null);
  assert.strictEqual(getContextLimit('some-other-model'), null);
});

summary();

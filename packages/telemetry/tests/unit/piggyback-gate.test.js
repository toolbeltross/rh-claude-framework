/**
 * Tests for scripts/piggyback-gate.js — shouldPiggybackStatus()
 *
 * The gate decides whether a PostToolUse event also emits a synthetic
 * /api/status "toolPiggyback" post (which materializes a top-level live
 * session). It must fire for interactive sessions but be suppressed for agent
 * tool events, so background/subagent runs don't surface as phantom session
 * tabs (regression: ~30 rh-daily-guidance tabs on 2026-06-19).
 */
import assert from 'assert';
import { test, summary } from '../helpers/test-harness.js';
import { shouldPiggybackStatus } from '../../scripts/piggyback-gate.js';

console.log('piggyback-gate tests:\n');

test('interactive session (no agent attribution) → piggyback fires', () => {
  assert.strictEqual(
    shouldPiggybackStatus({ transcriptPath: '/t.jsonl', sessionId: 's1' }),
    true,
  );
});

test('Task subagent (agent_id present) → suppressed', () => {
  assert.strictEqual(
    shouldPiggybackStatus({ transcriptPath: '/t.jsonl', sessionId: 's1', agentId: 'agent-123' }),
    false,
  );
});

test('headless --agent run (agent_type set, agentId null) → suppressed', () => {
  // The exact daily-guidance shape observed in the snapshot: type without id.
  assert.strictEqual(
    shouldPiggybackStatus({ transcriptPath: '/t.jsonl', sessionId: 's1', agentId: null, agentType: 'rh-daily-guidance' }),
    false,
  );
});

test('missing transcriptPath → false (nothing to parse)', () => {
  assert.strictEqual(shouldPiggybackStatus({ sessionId: 's1' }), false);
});

test('missing sessionId → false (nothing to key on)', () => {
  assert.strictEqual(shouldPiggybackStatus({ transcriptPath: '/t.jsonl' }), false);
});

test('empty-string agent fields are treated as absent → fires', () => {
  // hook-forwarder may pass '' rather than undefined; '' is falsy → interactive.
  assert.strictEqual(
    shouldPiggybackStatus({ transcriptPath: '/t.jsonl', sessionId: 's1', agentId: '', agentType: '' }),
    true,
  );
});

test('no args → false (defensive)', () => {
  assert.strictEqual(shouldPiggybackStatus(), false);
});

summary();

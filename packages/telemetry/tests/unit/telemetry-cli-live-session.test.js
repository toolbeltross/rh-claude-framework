/**
 * Tests for scripts/telemetry-cli.js live-session selection + normalization.
 *
 * Regression coverage for the multi-session bug: with several concurrent Claude
 * sessions POSTing live status, the CLI used to return whichever session pinged
 * most recently (max _lastSeen) regardless of which session/CWD invoked it, and
 * it read context_window fields that don't exist in the payload (total_tokens /
 * input_tokens) — silently falling back to the 200K default for 1M-context
 * Opus sessions. These helpers are pure, so no server is needed.
 */
import assert from 'assert';
import { test, summary } from '../helpers/test-harness.js';
import { selectLiveSession, normalizeLiveSession, normalizeDir } from '../../scripts/telemetry-cli.js';

console.log('telemetry-cli live-session tests:\n');

// Mirrors the real /api/snapshot liveSessions shape (4 concurrent sessions).
function fixture() {
  return {
    'mine-aaaa': {
      session_id: 'mine-aaaa',
      _lastSeen: 1000, // NOT the most recent
      workspace: { current_dir: 'C:\\Users\\u\\Workspace\\proj-a' },
      model: { id: 'claude-opus-4-8', display_name: 'Opus' },
      cost: { total_cost_usd: 2.99 },
      context_window: {
        total_input_tokens: 175059,
        context_window_size: 1000000,
        used_percentage: 18,
        current_usage: {
          input_tokens: 36170,
          output_tokens: 7386,
          cache_read_input_tokens: 1122991,
          cache_creation_input_tokens: 11222,
        },
      },
    },
    'other-proj': {
      session_id: 'other-proj',
      _lastSeen: 9999, // most recent — the legacy code would wrongly pick this
      workspace: { current_dir: 'C:\\Users\\u\\Workspace\\proj-b' },
      model: { id: '', display_name: '' },
      cost: { total_cost_usd: 0 },
      context_window: null,
    },
    'same-proj-older': {
      session_id: 'same-proj-older',
      _lastSeen: 500,
      workspace: { current_dir: 'C:/Users/u/Workspace/proj-a' }, // same dir, fwd slashes
      model: { id: 'claude-opus-4-8', display_name: 'Opus' },
      cost: { total_cost_usd: 5.0 },
      context_window: null,
    },
  };
}

// ─── selectLiveSession ───────────────────────────────────────────────────────

test('selectLiveSession: exact session_id wins even when another is more recent', () => {
  const picked = selectLiveSession(fixture(), { sessionId: 'mine-aaaa', cwd: 'C:\\Users\\u\\Workspace\\proj-a' });
  assert.ok(picked, 'a session was picked');
  assert.strictEqual(picked[0], 'mine-aaaa', 'picked my session, not the max-_lastSeen one');
});

test('selectLiveSession: falls back to CWD match when session_id is unknown', () => {
  // No session_id (e.g. env var absent). Should scope to the invoking project,
  // and among same-CWD sessions pick the most recent (mine-aaaa @1000 > older @500).
  const picked = selectLiveSession(fixture(), { sessionId: undefined, cwd: 'C:/Users/u/Workspace/proj-a/' });
  assert.strictEqual(picked[0], 'mine-aaaa', 'CWD-scoped, most-recent of that project');
});

test('selectLiveSession: CWD match beats a more-recent session in a different project', () => {
  const picked = selectLiveSession(fixture(), { cwd: 'C:\\Users\\u\\Workspace\\proj-a' });
  assert.notStrictEqual(picked[0], 'other-proj', 'did not pick the unrelated most-recent project');
});

test('selectLiveSession: legacy fallback to globally most-recent when no scope matches', () => {
  const picked = selectLiveSession(fixture(), { sessionId: 'nope', cwd: 'C:/elsewhere' });
  assert.strictEqual(picked[0], 'other-proj', 'most-recent _lastSeen wins as last resort');
});

test('selectLiveSession: empty/missing map returns null', () => {
  assert.strictEqual(selectLiveSession({}, { sessionId: 'x' }), null);
  assert.strictEqual(selectLiveSession(undefined, {}), null);
});

// ─── normalizeLiveSession ────────────────────────────────────────────────────

test('normalizeLiveSession: reads the real payload fields (1M limit, not 200K default)', () => {
  const n = normalizeLiveSession(fixture()['mine-aaaa'], 'mine-aaaa');
  assert.strictEqual(n.contextWindow.limit, 1000000, 'limit from context_window_size, not 200K fallback');
  assert.strictEqual(n.contextWindow.usedPercentage, 18, 'authoritative used_percentage');
  assert.strictEqual(n.contextWindow.usedTokens, 175059, 'occupancy from total_input_tokens');
  assert.strictEqual(n.contextWindow.cacheRead, 1122991, 'cacheRead from current_usage.cache_read_input_tokens');
  assert.strictEqual(n.contextWindow.cacheWrite, 11222, 'cacheWrite from current_usage.cache_creation_input_tokens');
  assert.strictEqual(n.projectName, 'proj-a');
});

test('normalizeLiveSession: derives 1M from model name when size is absent', () => {
  const raw = {
    session_id: 's',
    workspace: { current_dir: '/x/proj' },
    model: { display_name: 'Opus 4.8 (1M context)' },
    context_window: { total_input_tokens: 50000 }, // no context_window_size
  };
  const n = normalizeLiveSession(raw, 's');
  assert.strictEqual(n.contextWindow.limit, 1000000, '1M detected via model display name');
});

test('normalizeLiveSession: null context_window yields null contextWindow (not a crash)', () => {
  const n = normalizeLiveSession(fixture()['same-proj-older'], 'same-proj-older');
  assert.strictEqual(n.contextWindow, null);
  assert.strictEqual(n.cost, 5.0);
});

// ─── normalizeDir ────────────────────────────────────────────────────────────

test('normalizeDir: backslash/forward-slash/case/trailing-slash collapse to one key', () => {
  assert.strictEqual(
    normalizeDir('C:\\Users\\U\\Workspace\\Proj\\'),
    normalizeDir('c:/users/u/workspace/proj')
  );
  assert.strictEqual(normalizeDir(''), '');
  assert.strictEqual(normalizeDir(null), '');
});

summary();

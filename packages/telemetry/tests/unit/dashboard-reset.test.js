/**
 * Unit tests for dashboard-reset vectors.
 *
 * The dashboard has historically reset (flashed to empty) when:
 * - .claude.json was mid-write and parseAll returned null/empty data
 * - pruneStale removed sessions the user was viewing
 * - getSnapshot returned stale/empty state after server init
 *
 * These tests verify the store-level guards that prevent those resets.
 */
import assert from 'assert';
import { test, summary } from '../helpers/test-harness.js';
import { Store } from '../../server/store.js';

console.log('dashboard-reset unit tests:\n');

// --- store.update() guards ---

test('update: null currentSession does not overwrite existing', () => {
  const s = new Store();
  const existing = { sessionId: 's1', cost: 1.23 };
  s.data.currentSession = existing;
  s.update({ currentSession: null, sessions: null, stats: null });
  assert.strictEqual(s.data.currentSession, existing);
});

test('update: null stats does not overwrite existing', () => {
  const s = new Store();
  const existing = { totalSessions: 42 };
  s.data.stats = existing;
  s.update({ currentSession: null, sessions: null, stats: null });
  assert.strictEqual(s.data.stats, existing);
});

test('update: valid currentSession replaces existing', () => {
  const s = new Store();
  s.data.currentSession = { sessionId: 'old' };
  const next = { sessionId: 'new', cost: 2.50 };
  s.update({ currentSession: next, sessions: null, stats: null });
  assert.strictEqual(s.data.currentSession, next);
});

test('update: all-null parse does not emit update event', () => {
  const s = new Store();
  s.data.currentSession = { sessionId: 's1' };
  s.data.sessions = [{ sessionId: 's1' }];
  s.data.stats = { totalSessions: 1 };
  let emitted = false;
  s.on('update', () => { emitted = true; });
  s.update({ currentSession: null, sessions: null, stats: null });
  assert.strictEqual(emitted, false, 'no-op parse should not broadcast');
});

test('update: partial parse emits only changed fields', () => {
  const s = new Store();
  s.data.currentSession = { sessionId: 'old' };
  let changed = null;
  s.on('update', (data) => { changed = data; });
  s.update({ currentSession: { sessionId: 'new' }, sessions: null, stats: null });
  assert.ok(changed);
  assert.ok(changed.currentSession);
  assert.strictEqual(changed.sessions, undefined, 'null sessions should not appear in changed');
  assert.strictEqual(changed.stats, undefined, 'null stats should not appear in changed');
});

// --- getSnapshot() completeness ---

test('getSnapshot: includes accumulated toolEvents', () => {
  const s = new Store();
  s.addToolEvent({ tool_name: 'Read', session_id: 'sess1', cwd: '/tmp' });
  s.addToolEvent({ tool_name: 'Bash', session_id: 'sess1', cwd: '/tmp' });
  const snap = s.getSnapshot();
  assert.strictEqual(snap.toolEvents.length, 2);
  assert.strictEqual(snap.toolEvents[0].tool, 'Bash');
  assert.strictEqual(snap.toolEvents[1].tool, 'Read');
});

test('getSnapshot: includes liveSessions from statusLine', () => {
  const s = new Store();
  s.updateLiveSession({
    session_id: 'live1',
    model: { display_name: 'Opus 4.6' },
    cost: { total_cost_usd: 3.14 },
  });
  const snap = s.getSnapshot();
  assert.ok(snap.liveSessions.live1);
  assert.strictEqual(snap.liveSessions.live1.cost.total_cost_usd, 3.14);
});

test('getSnapshot: includes liveSessions derived from toolEvents', () => {
  const s = new Store();
  s.addToolEvent({ tool_name: 'Read', session_id: 'derived1', cwd: '/tmp/proj' });
  const snap = s.getSnapshot();
  assert.ok(snap.liveSessions.derived1, 'tool-event-derived session should be in snapshot');
  assert.strictEqual(snap.liveSessions.derived1._fromToolEvents, true);
});

test('getSnapshot: returns shallow copy — mutations do not affect store', () => {
  const s = new Store();
  s.addToolEvent({ tool_name: 'Read', session_id: 'x', cwd: '/tmp' });
  const snap = s.getSnapshot();
  snap.toolEvents = [];
  assert.strictEqual(s.data.toolEvents.length, 1, 'store data should be unaffected');
});

// --- pruneStale does not remove active sessions ---

test('pruneStale: active session survives', () => {
  const s = new Store();
  s.updateLiveSession({
    session_id: 'active1',
    model: { display_name: 'Opus' },
    cost: { total_cost_usd: 1.0 },
  });
  s.pruneStale(60_000);
  assert.ok(s.data.liveSessions.active1, 'recently-seen session should survive prune');
});

test('pruneStale: stale session is removed', () => {
  const s = new Store();
  s.updateLiveSession({
    session_id: 'stale1',
    model: { display_name: 'Opus' },
    cost: { total_cost_usd: 1.0 },
  });
  // Backdate _lastSeen
  s.data.liveSessions.stale1._lastSeen = Date.now() - 3 * 60 * 60 * 1000;
  s.pruneStale(2 * 60 * 60 * 1000);
  assert.strictEqual(s.data.liveSessions.stale1, undefined, 'stale session should be pruned');
});

test('pruneStale: emits update with surviving sessions only', () => {
  const s = new Store();
  s.updateLiveSession({
    session_id: 'keep',
    model: { display_name: 'Opus' },
    cost: { total_cost_usd: 1.0 },
  });
  s.updateLiveSession({
    session_id: 'remove',
    model: { display_name: 'Haiku' },
    cost: { total_cost_usd: 0.01 },
  });
  s.data.liveSessions.remove._lastSeen = 0;

  let emittedData = null;
  s.on('update', (data) => { emittedData = data; });
  s.pruneStale(60_000);

  assert.ok(emittedData, 'should emit update when sessions pruned');
  assert.ok(emittedData.liveSessions.keep, 'surviving session should be in emitted data');
  assert.strictEqual(emittedData.liveSessions.remove, undefined, 'pruned session should not be in emitted data');
});

test('pruneStale: no-change prune does not emit update', () => {
  const s = new Store();
  s.updateLiveSession({
    session_id: 'fresh',
    model: { display_name: 'Opus' },
    cost: { total_cost_usd: 1.0 },
  });
  let emitted = false;
  s.on('update', () => { emitted = true; });
  s.pruneStale(60_000);
  assert.strictEqual(emitted, false, 'no prune = no emit');
});

// --- updateLiveSession preserves accumulated state ---

test('updateLiveSession: preserves turnCount across updates', () => {
  const s = new Store();
  s.updateLiveSession({
    session_id: 'sess1',
    model: { display_name: 'Opus' },
    cost: { total_cost_usd: 1.0 },
  });
  s.recordTurnEnd('sess1', {});
  s.recordTurnEnd('sess1', {});
  assert.strictEqual(s.data.liveSessions.sess1._turnCount, 2);

  // Second statusLine update should not reset turn count
  s.updateLiveSession({
    session_id: 'sess1',
    model: { display_name: 'Opus' },
    cost: { total_cost_usd: 2.0 },
  });
  assert.strictEqual(s.data.liveSessions.sess1._turnCount, 2, 'turn count must survive statusLine update');
});

test('updateLiveSession: preserves subagent state across updates', () => {
  const s = new Store();
  s.updateLiveSession({
    session_id: 'sess1',
    model: { display_name: 'Opus' },
    cost: { total_cost_usd: 1.0 },
  });
  s.addSubagent('sess1', { agent_id: 'a1', agent_type: 'Explore' });

  // StatusLine update should not wipe subagents
  s.updateLiveSession({
    session_id: 'sess1',
    model: { display_name: 'Opus' },
    cost: { total_cost_usd: 2.0 },
  });
  assert.ok(s.data.liveSessions.sess1._activeSubagents.a1, 'subagent must survive statusLine update');
});

test('updateLiveSession: preserves prompt state across updates', () => {
  const s = new Store();
  s.updateLiveSession({
    session_id: 'sess1',
    model: { display_name: 'Opus' },
    cost: { total_cost_usd: 1.0 },
  });
  s.updatePrompt('sess1', 'fix the bug');

  // StatusLine update should not wipe prompt
  s.updateLiveSession({
    session_id: 'sess1',
    model: { display_name: 'Opus' },
    cost: { total_cost_usd: 2.0 },
  });
  assert.strictEqual(s.data.liveSessions.sess1._currentPrompt, 'fix the bug', 'prompt must survive statusLine update');
});

test('updateLiveSession: preserves compact events across updates', () => {
  const s = new Store();
  s.updateLiveSession({
    session_id: 'sess1',
    model: { display_name: 'Opus' },
    cost: { total_cost_usd: 1.0 },
  });
  s.recordCompact('sess1', { trigger: 'auto' });

  s.updateLiveSession({
    session_id: 'sess1',
    model: { display_name: 'Opus' },
    cost: { total_cost_usd: 2.0 },
  });
  assert.strictEqual(s.data.liveSessions.sess1._compactEvents.length, 1, 'compact events must survive statusLine update');
});

test('updateLiveSession: preserves toolCount from derived sessions', () => {
  const s = new Store();
  // Tool events create a derived session
  s.addToolEvent({ tool_name: 'Read', session_id: 'sess1', cwd: '/tmp' });
  s.addToolEvent({ tool_name: 'Bash', session_id: 'sess1', cwd: '/tmp' });
  assert.strictEqual(s.data.liveSessions.sess1._toolCount, 2);

  // StatusLine POST should preserve the tool count
  s.updateLiveSession({
    session_id: 'sess1',
    model: { display_name: 'Opus' },
    cost: { total_cost_usd: 1.0 },
  });
  assert.strictEqual(s.data.liveSessions.sess1._toolCount, 2, 'tool count must survive statusLine upgrade');
  assert.strictEqual(s.data.liveSessions.sess1._fromStatusLine, true);
});

// --- Rapid update cycles (simulating chokidar thrashing) ---

test('rapid updates: liveSessions not affected by file-watcher updates', () => {
  const s = new Store();
  s.updateLiveSession({
    session_id: 'live1',
    model: { display_name: 'Opus' },
    cost: { total_cost_usd: 5.0 },
  });

  // Simulate 5 rapid file-watcher update cycles (chokidar fires on .claude.json changes)
  for (let i = 0; i < 5; i++) {
    s.update({
      currentSession: { sessionId: `s${i}`, cost: i },
      sessions: [{ sessionId: `s${i}` }],
      stats: { totalSessions: i },
    });
  }

  assert.ok(s.data.liveSessions.live1, 'live session must survive file-watcher updates');
  assert.strictEqual(s.data.liveSessions.live1.cost.total_cost_usd, 5.0);
});

test('rapid updates: toolEvents not affected by file-watcher updates', () => {
  const s = new Store();
  s.addToolEvent({ tool_name: 'Read', session_id: 'sess1', cwd: '/tmp' });
  s.addToolEvent({ tool_name: 'Bash', session_id: 'sess1', cwd: '/tmp' });

  // File-watcher updates should not touch toolEvents
  for (let i = 0; i < 5; i++) {
    s.update({
      currentSession: { sessionId: `s${i}` },
      sessions: [{ sessionId: `s${i}` }],
      stats: null,
    });
  }

  assert.strictEqual(s.data.toolEvents.length, 2, 'tool events must survive file-watcher updates');
});

// --- forceRefresh edge cases ---

test('forceRefresh: keeps recently-seen sessions', () => {
  const s = new Store();
  s.updateLiveSession({
    session_id: 'recent',
    model: { display_name: 'Opus' },
    cost: { total_cost_usd: 1.0 },
  });
  const result = s.forceRefresh();
  assert.strictEqual(result.remaining, 1);
  assert.strictEqual(result.pruned, 0);
  assert.ok(s.data.liveSessions.recent);
});

test('forceRefresh: removes sessions older than 5 minutes', () => {
  const s = new Store();
  s.updateLiveSession({
    session_id: 'old',
    model: { display_name: 'Opus' },
    cost: { total_cost_usd: 1.0 },
  });
  s.data.liveSessions.old._lastSeen = Date.now() - 10 * 60 * 1000;
  const result = s.forceRefresh();
  assert.strictEqual(result.pruned, 1);
  assert.strictEqual(result.remaining, 0);
});

test('forceRefresh: always emits update even when nothing pruned', () => {
  const s = new Store();
  let emitted = false;
  s.on('update', () => { emitted = true; });
  s.forceRefresh();
  assert.strictEqual(emitted, true, 'forceRefresh should always emit');
});

summary();

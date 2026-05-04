/**
 * Tests for server/store.js — uses the Store class export so each test gets
 * a fresh instance and the singleton is never polluted.
 */
import assert from 'assert';
import { join } from 'path';
import { test, summary, assertEvent } from '../helpers/test-harness.js';
import { withTmp } from '../helpers/tmp.js';
import { Store } from '../../server/store.js';

/** Build a Store with its failureStore redirected to a tmp file. */
function storeWithTmpFailures(tmp) {
  const s = new Store();
  s.failureStore.filePath = join(tmp, 'telemetry-failures.jsonl');
  return s;
}

const _savedCtxEnv = process.env.CLAUDE_CONTEXT_WINDOW_SIZE;
delete process.env.CLAUDE_CONTEXT_WINDOW_SIZE;
process.on('exit', () => {
  if (_savedCtxEnv !== undefined) process.env.CLAUDE_CONTEXT_WINDOW_SIZE = _savedCtxEnv;
});

console.log('store tests:\n');

// --- addToolEvent ---
test('addToolEvent: basic event recorded in toolEvents', () => {
  const s = new Store();
  s.addToolEvent({ tool_name: 'Read', session_id: 'abc', cwd: '/tmp' });
  assert.strictEqual(s.data.toolEvents.length, 1);
  assert.strictEqual(s.data.toolEvents[0].tool, 'Read');
  assert.strictEqual(s.data.toolEvents[0].session, 'abc');
});

test('addToolEvent: derives liveSession from tool event when no statusLine data', () => {
  const s = new Store();
  s.addToolEvent({ tool_name: 'Read', session_id: 'abc', cwd: '/tmp/proj' });
  const live = s.data.liveSessions.abc;
  assert.ok(live);
  assert.strictEqual(live._fromToolEvents, true);
  assert.strictEqual(live._toolCount, 1);
  assert.strictEqual(live._lastTool, 'Read');
});

test('addToolEvent: increments tool count on existing derived session', () => {
  const s = new Store();
  s.addToolEvent({ tool_name: 'Read', session_id: 'abc', cwd: '/tmp' });
  s.addToolEvent({ tool_name: 'Bash', session_id: 'abc', cwd: '/tmp' });
  assert.strictEqual(s.data.liveSessions.abc._toolCount, 2);
  assert.strictEqual(s.data.liveSessions.abc._lastTool, 'Bash');
});

test('addToolEvent: FIRST event on a fresh session lands in _currentTurnEvents', () => {
  // Regression: B2 originally placed the per-turn accumulator BEFORE the
  // live-session derivation block, so on a brand-new session the first
  // event was missed (no session entry existed yet at the accumulator).
  // Fixed by relocating the accumulator past derivation.
  const s = new Store();
  s.addToolEvent({ tool_name: 'Read', session_id: 'fresh', duration_ms: 180, cwd: '/tmp' });
  const events = s.data.liveSessions.fresh._currentTurnEvents;
  assert.ok(Array.isArray(events), 'accumulator array initialized');
  assert.strictEqual(events.length, 1, 'first event captured');
  assert.strictEqual(events[0].tool, 'Read');
  assert.strictEqual(events[0].durationMs, 180);
});

test('addToolEvent: subsequent events also accumulate in _currentTurnEvents', () => {
  const s = new Store();
  s.addToolEvent({ tool_name: 'Read', session_id: 'multi', duration_ms: 100, cwd: '/tmp' });
  s.addToolEvent({ tool_name: 'Bash', session_id: 'multi', duration_ms: 250, cwd: '/tmp' });
  s.addToolEvent({ tool_name: 'Edit', session_id: 'multi', duration_ms: 80, cwd: '/tmp' });
  const events = s.data.liveSessions.multi._currentTurnEvents;
  assert.strictEqual(events.length, 3);
  assert.deepStrictEqual(events.map(e => e.tool), ['Read', 'Bash', 'Edit']);
});

// --- updateLiveSession ---
test('updateLiveSession: marks _fromStatusLine and preserves prior _toolCount', () => {
  const s = new Store();
  s.addToolEvent({ tool_name: 'Read', session_id: 'abc', cwd: '/tmp' });
  s.addToolEvent({ tool_name: 'Read', session_id: 'abc', cwd: '/tmp' });
  s.updateLiveSession({
    session_id: 'abc',
    model: { display_name: 'Opus 4.6', id: 'claude-opus-4-6' },
    cost: { total_cost_usd: 0.5 },
    context_window: { context_window_size: 200000, total_input_tokens: 50000, used_percentage: 25, current_usage: {} },
  });
  const live = s.data.liveSessions.abc;
  assert.strictEqual(live._fromStatusLine, true);
  assert.strictEqual(live._toolCount, 2, 'tool count should be preserved across statusLine update');
});

test('updateLiveSession: tracks context history', () => {
  const s = new Store();
  s.updateLiveSession({
    session_id: 'abc',
    context_window: { context_window_size: 200000, total_input_tokens: 50000, used_percentage: 25, current_usage: {} },
  });
  s.updateLiveSession({
    session_id: 'abc',
    context_window: { context_window_size: 200000, total_input_tokens: 80000, used_percentage: 40, current_usage: {} },
  });
  const live = s.data.liveSessions.abc;
  assert.strictEqual(live._contextHistory.length, 2);
  assert.strictEqual(live._contextHistory[0].pct, 25);
  assert.strictEqual(live._contextHistory[1].pct, 40);
});

test('updateLiveSession: detects model switch', () => {
  const s = new Store();
  s.updateLiveSession({
    session_id: 'abc',
    model: { display_name: 'Opus 4.6' },
    context_window: { current_usage: {} },
  });
  s.updateLiveSession({
    session_id: 'abc',
    model: { display_name: 'Sonnet 4.6' },
    context_window: { current_usage: {} },
  });
  const live = s.data.liveSessions.abc;
  assert.strictEqual(live._modelSwitches.length, 1);
  assert.strictEqual(live._modelSwitches[0].from, 'Opus 4.6');
  assert.strictEqual(live._modelSwitches[0].to, 'Sonnet 4.6');
});

test('updateLiveSession: prefix model name suppresses switch, keeps longer name', () => {
  const s = new Store();
  s.updateLiveSession({
    session_id: 'abc',
    model: { display_name: 'Opus 4.6 (1M context)' },
    context_window: { current_usage: {} },
  });
  s.updateLiveSession({
    session_id: 'abc',
    model: { display_name: 'Opus' },
    context_window: { current_usage: {} },
  });
  const live = s.data.liveSessions.abc;
  assert.strictEqual(live._modelSwitches.length, 0, 'no switch for prefix match');
  assert.strictEqual(live._currentModel, 'Opus 4.6 (1M context)', 'keeps longer name');
});

test('updateLiveSession: shorter name first, longer prefix arrives later, keeps longer', () => {
  const s = new Store();
  s.updateLiveSession({
    session_id: 'abc',
    model: { display_name: 'Opus' },
    context_window: { current_usage: {} },
  });
  s.updateLiveSession({
    session_id: 'abc',
    model: { display_name: 'Opus 4.6 (1M context)' },
    context_window: { current_usage: {} },
  });
  const live = s.data.liveSessions.abc;
  assert.strictEqual(live._modelSwitches.length, 0, 'no switch for prefix match');
  assert.strictEqual(live._currentModel, 'Opus 4.6 (1M context)', 'keeps longer name');
});

test('updateLiveSession: repeated prefix flicker never accumulates switches', () => {
  const s = new Store();
  const names = ['Opus', 'Opus 4.6 (1M context)', 'Opus', 'Opus 4.6 (1M context)', 'Opus'];
  for (const name of names) {
    s.updateLiveSession({
      session_id: 'abc',
      model: { display_name: name },
      context_window: { current_usage: {} },
    });
  }
  const live = s.data.liveSessions.abc;
  assert.strictEqual(live._modelSwitches.length, 0, 'no switches from prefix flicker');
  assert.strictEqual(live._currentModel, 'Opus 4.6 (1M context)', 'settled on longer name');
});

test('updateLiveSession: different version numbers are real switches', () => {
  const s = new Store();
  s.updateLiveSession({
    session_id: 'abc',
    model: { display_name: 'Opus 4.6' },
    context_window: { current_usage: {} },
  });
  s.updateLiveSession({
    session_id: 'abc',
    model: { display_name: 'Opus 4.7' },
    context_window: { current_usage: {} },
  });
  const live = s.data.liveSessions.abc;
  assert.strictEqual(live._modelSwitches.length, 1, 'different versions are real switches');
  assert.strictEqual(live._modelSwitches[0].from, 'Opus 4.6');
  assert.strictEqual(live._modelSwitches[0].to, 'Opus 4.7');
});

// --- recordTurnEnd ---
test('recordTurnEnd: increments turn count', () => {
  const s = new Store();
  s.updateLiveSession({
    session_id: 'abc',
    context_window: { current_usage: {}, total_input_tokens: 1000, used_percentage: 1 },
  });
  s.recordTurnEnd('abc', {});
  assert.strictEqual(s.data.liveSessions.abc._turnCount, 1);
  s.recordTurnEnd('abc', {});
  assert.strictEqual(s.data.liveSessions.abc._turnCount, 2);
});

test('recordTurnEnd: appends to turn history', () => {
  const s = new Store();
  s.updateLiveSession({
    session_id: 'abc',
    context_window: { current_usage: {}, total_input_tokens: 1000, used_percentage: 1 },
  });
  s.recordTurnEnd('abc', {});
  s.recordTurnEnd('abc', {});
  assert.strictEqual(s.data.liveSessions.abc._turnHistory.length, 2);
});

test('recordTurnEnd: ignored if session does not exist', () => {
  const s = new Store();
  s.recordTurnEnd('nonexistent', {});
  assert.strictEqual(Object.keys(s.data.liveSessions).length, 0);
});

// --- recordCompact ---
test('recordCompact: appends to compactEvents and turn history', () => {
  const s = new Store();
  s.updateLiveSession({
    session_id: 'abc',
    context_window: { current_usage: {}, total_input_tokens: 100000, used_percentage: 50 },
  });
  s.recordCompact('abc', { trigger: 'auto' });
  assert.strictEqual(s.data.liveSessions.abc._compactEvents.length, 1);
  assert.strictEqual(s.data.liveSessions.abc._turnHistory[0].compact, true);
});

test('recordCompact: auto-creates session entry when no live session exists yet', () => {
  // Guards against the silent-drop bug: if PreCompact fires before statusLine
  // or any tool event has created the liveSessions entry, recordCompact used
  // to return silently and the compaction was lost. Mint a thin entry instead.
  const s = new Store();
  s.recordCompact('fresh-session', { trigger: 'manual' });
  const live = s.data.liveSessions['fresh-session'];
  assert.ok(live, 'recordCompact should create a live session entry when missing');
  assert.strictEqual(live._compactEvents.length, 1);
  assert.strictEqual(live._compactEvents[0].trigger, 'manual');
  assert.ok(live._lastCompactAt, '_lastCompactAt should be set');
});

test('recordCompact: emits compactEvent even when minting a fresh session', () => {
  const s = new Store();
  let seen = null;
  s.on('compactEvent', (e) => { seen = e; });
  s.recordCompact('fresh-session', { trigger: 'auto' });
  assert.ok(seen, 'compactEvent should fire');
  assert.strictEqual(seen.sessionId, 'fresh-session');
  assert.strictEqual(seen.trigger, 'auto');
});

// --- updateLiveSession: used_percentage recalculation for extended-context models ---
test('updateLiveSession: recalculates used_percentage for 1M-context model', () => {
  // Regression guard: statusLine reports used_percentage computed against 200k
  // even on 1M-context sessions. After resolving the real size, used_percentage
  // must be rewritten to reflect the real utilization — or the CLI and any
  // component reading used_percentage directly shows a bogus value.
  const s = new Store();
  s.updateLiveSession({
    session_id: 'opus1m',
    model: { id: 'claude-opus-4-6[1m]', display_name: 'Opus 4.6 (1M context)' },
    context_window: {
      context_window_size: 200000,
      total_input_tokens: 284918,
      used_percentage: 100, // wrong — computed against 200k
      current_usage: {},
    },
  });
  const live = s.data.liveSessions.opus1m;
  assert.strictEqual(live.context_window._resolvedSize, 1_000_000);
  assert.strictEqual(
    live.context_window.used_percentage,
    28,
    'used_percentage should be recomputed against the resolved 1M window',
  );
});

test('updateLiveSession: leaves used_percentage alone when resolved size matches reported', () => {
  const s = new Store();
  s.updateLiveSession({
    session_id: '200k',
    model: { id: 'claude-opus-4-6', display_name: 'Opus 4.6' },
    context_window: {
      context_window_size: 200000,
      total_input_tokens: 50000,
      used_percentage: 25,
      current_usage: {},
    },
  });
  const live = s.data.liveSessions['200k'];
  assert.strictEqual(live.context_window.used_percentage, 25);
});

// --- updateStatusLineState ---
test('updateStatusLineState: emits only when class changes', async () => {
  const s = new Store();
  let events = 0;
  s.on('statusLineState', () => events++);
  s.updateStatusLineState({ class: 'telemetry' });
  s.updateStatusLineState({ class: 'telemetry' }); // same class — no emit
  s.updateStatusLineState({ class: 'placeholder' }); // change — emit
  assert.strictEqual(events, 2);
});

test('updateStatusLineState: emits when stalled flag toggles', () => {
  const s = new Store();
  let events = 0;
  s.on('statusLineState', () => events++);
  s.updateStatusLineState({ class: 'telemetry', stalled: false });
  s.updateStatusLineState({ class: 'telemetry', stalled: true });  // change — emit
  s.updateStatusLineState({ class: 'telemetry', stalled: true });  // no change
  s.updateStatusLineState({ class: 'telemetry', stalled: false }); // change — emit
  assert.strictEqual(events, 3);
});

// --- recordStatusLinePost ---
test('recordStatusLinePost: resets counter and clears stalled', () => {
  const s = new Store();
  s.data.statusLineState.lastStatusPostAt = Date.now() - 200_000;
  s._toolEventsSinceLastStatusPost = 5;
  s.data.statusLineState.stalled = true;
  s.recordStatusLinePost();
  assert.strictEqual(s._toolEventsSinceLastStatusPost, 0);
  assert.strictEqual(s.data.statusLineState.stalled, false);
});

// --- Stall detection (permanent port of Phase 5 manual tests) ---
test('stall: first-run guard — no stall before first statusLine post', () => {
  const s = new Store();
  for (let i = 0; i < 10; i++) {
    s.addToolEvent({ tool_name: 'Read', session_id: 'abc', cwd: '/tmp' });
  }
  assert.strictEqual(s.data.statusLineState.stalled, false);
});

test('stall: aged + 3 tool events triggers stall', () => {
  const s = new Store();
  s.recordStatusLinePost();
  s.data.statusLineState.lastStatusPostAt = Date.now() - 200_000;
  s.addToolEvent({ tool_name: 'Read', session_id: 'abc', cwd: '/tmp' });
  assert.strictEqual(s.data.statusLineState.stalled, false, '1 tool event not enough');
  s.addToolEvent({ tool_name: 'Read', session_id: 'abc', cwd: '/tmp' });
  assert.strictEqual(s.data.statusLineState.stalled, false, '2 tool events not enough');
  s.addToolEvent({ tool_name: 'Read', session_id: 'abc', cwd: '/tmp' });
  assert.strictEqual(s.data.statusLineState.stalled, true, '3 tool events triggers');
});

test('stall: new statusLine post clears and emits', () => {
  const s = new Store();
  s.recordStatusLinePost();
  s.data.statusLineState.lastStatusPostAt = Date.now() - 200_000;
  for (let i = 0; i < 3; i++) s.addToolEvent({ tool_name: 'Read', session_id: 'abc', cwd: '/tmp' });
  assert.strictEqual(s.data.statusLineState.stalled, true);
  let cleared = false;
  s.on('statusLineState', (state) => { if (!state.stalled) cleared = true; });
  s.recordStatusLinePost();
  assert.strictEqual(s.data.statusLineState.stalled, false);
  assert.strictEqual(cleared, true);
});

test('stall: counter resets on each statusLine post', () => {
  const s = new Store();
  s.recordStatusLinePost();
  s.addToolEvent({ tool_name: 'Read', session_id: 'abc', cwd: '/tmp' });
  s.addToolEvent({ tool_name: 'Read', session_id: 'abc', cwd: '/tmp' });
  s.recordStatusLinePost();
  assert.strictEqual(s._toolEventsSinceLastStatusPost, 0);
});

// --- update() guards against transient empty data ---
test('update: empty sessions array does not overwrite existing sessions', () => {
  const s = new Store();
  const existing = [{ sessionId: 's1', projectName: 'proj' }];
  s.data.sessions = existing;
  s.update({ sessions: [], stats: null, currentSession: null });
  assert.strictEqual(s.data.sessions, existing, 'sessions should be preserved');
  assert.strictEqual(s.data.sessions.length, 1);
});

test('update: null sessions does not overwrite existing sessions', () => {
  const s = new Store();
  const existing = [{ sessionId: 's1', projectName: 'proj' }];
  s.data.sessions = existing;
  s.update({ sessions: null, stats: null, currentSession: null });
  assert.strictEqual(s.data.sessions, existing, 'sessions should be preserved');
});

test('update: non-empty sessions replaces existing sessions', () => {
  const s = new Store();
  s.data.sessions = [{ sessionId: 'old' }];
  const newSessions = [{ sessionId: 'new1' }, { sessionId: 'new2' }];
  s.update({ sessions: newSessions, stats: null, currentSession: null });
  assert.strictEqual(s.data.sessions, newSessions);
  assert.strictEqual(s.data.sessions.length, 2);
});

test('update: no-op parse (all null) does not emit update', () => {
  const s = new Store();
  let emitted = false;
  s.on('update', () => { emitted = true; });
  s.update({ sessions: null, stats: null, currentSession: null });
  assert.strictEqual(emitted, false, 'should not emit when nothing changed');
});

// --- Snapshot shape ---
// --- subagent orphan sweep & compaction crossover ---
test('addSubagent: initial shape includes _lastToolAt and _spannedCompactAt', () => {
  const s = new Store();
  s.updateLiveSession({ session_id: 'sess1', cost: { total_cost_usd: 0 } });
  s.addSubagent('sess1', { agent_id: 'agent-1', agent_type: 'Explore' });
  const agent = s.data.liveSessions.sess1._activeSubagents['agent-1'];
  assert.strictEqual(agent._lastToolAt, null);
  assert.strictEqual(agent._spannedCompactAt, null);
});

test('addToolEvent: stamps _lastToolAt on the active subagent', () => {
  const s = new Store();
  s.updateLiveSession({ session_id: 'sess1', cost: { total_cost_usd: 0 } });
  s.addSubagent('sess1', { agent_id: 'agent-1', agent_type: 'Explore' });
  const before = Date.now();
  s.addToolEvent({ tool_name: 'Read', session_id: 'sess1', agent_id: 'agent-1' });
  const agent = s.data.liveSessions.sess1._activeSubagents['agent-1'];
  assert.ok(agent._lastToolAt >= before, '_lastToolAt should be set to a recent timestamp');
});

test('recordCompact: stamps _spannedCompactAt on all active subagents', () => {
  const s = new Store();
  s.updateLiveSession({ session_id: 'sess1', cost: { total_cost_usd: 0 } });
  s.addSubagent('sess1', { agent_id: 'agent-1', agent_type: 'Explore' });
  s.addSubagent('sess1', { agent_id: 'agent-2', agent_type: 'facilitator' });
  s.recordCompact('sess1', { trigger: 'auto' });
  const active = s.data.liveSessions.sess1._activeSubagents;
  assert.strictEqual(active['agent-1']._spannedCompactAt.length, 1);
  assert.strictEqual(active['agent-2']._spannedCompactAt.length, 1);
});

test('recordCompact: appends (not overwrites) _spannedCompactAt on repeated compactions', () => {
  const s = new Store();
  s.updateLiveSession({ session_id: 'sess1', cost: { total_cost_usd: 0 } });
  s.addSubagent('sess1', { agent_id: 'agent-1', agent_type: 'Explore' });
  s.recordCompact('sess1', { trigger: 'auto' });
  s.recordCompact('sess1', { trigger: 'manual' });
  const agent = s.data.liveSessions.sess1._activeSubagents['agent-1'];
  assert.strictEqual(agent._spannedCompactAt.length, 2);
});

test('removeSubagent: carries spannedCompactAt into history entry', () => {
  const s = new Store();
  s.updateLiveSession({ session_id: 'sess1', cost: { total_cost_usd: 0 } });
  s.addSubagent('sess1', { agent_id: 'agent-1', agent_type: 'Explore' });
  s.recordCompact('sess1', { trigger: 'auto' });
  s.removeSubagent('sess1', { agent_id: 'agent-1', agent_type: 'Explore' });
  const hist = s.data.liveSessions.sess1._subagentHistory;
  assert.strictEqual(hist.length, 1);
  assert.strictEqual(hist[0].status, 'completed');
  assert.strictEqual(hist[0].spannedCompactAt.length, 1);
});

test('sweepOrphanedSubagents: no-op when no active agents', () => {
  const s = new Store();
  s.updateLiveSession({ session_id: 'sess1', cost: { total_cost_usd: 0 } });
  const result = s.sweepOrphanedSubagents(1000);
  assert.strictEqual(result, false);
});

test('sweepOrphanedSubagents: leaves fresh agents alone', () => {
  const s = new Store();
  s.updateLiveSession({ session_id: 'sess1', cost: { total_cost_usd: 0 } });
  s.addSubagent('sess1', { agent_id: 'agent-1', agent_type: 'Explore' });
  // Threshold is 10 seconds; agent just started
  const result = s.sweepOrphanedSubagents(10_000);
  assert.strictEqual(result, false);
  assert.ok(s.data.liveSessions.sess1._activeSubagents['agent-1']);
});

test('sweepOrphanedSubagents: moves stale agents to history with status:orphaned', async () => {
  await withTmp(async (tmp) => {
    const s = storeWithTmpFailures(tmp);
    s.updateLiveSession({ session_id: 'sess1', cost: { total_cost_usd: 0 } });
    s.addSubagent('sess1', { agent_id: 'agent-1', agent_type: 'Explore' });
    // Backdate the agent's startedAt beyond the threshold
    s.data.liveSessions.sess1._activeSubagents['agent-1'].startedAt = Date.now() - 60_000;
    const result = s.sweepOrphanedSubagents(10_000);
    assert.strictEqual(result, true);
    assert.strictEqual(Object.keys(s.data.liveSessions.sess1._activeSubagents).length, 0);
    const hist = s.data.liveSessions.sess1._subagentHistory;
    assert.strictEqual(hist.length, 1);
    assert.strictEqual(hist[0].status, 'orphaned');
    assert.strictEqual(hist[0].agentId, 'agent-1');
    assert.ok(hist[0].orphanedAfterMs >= 60_000);
  }, 'sweep-basic');
});

test('sweepOrphanedSubagents: writes a failure-store row for each orphan', async () => {
  await withTmp(async (tmp) => {
    const s = storeWithTmpFailures(tmp);
    s.updateLiveSession({ session_id: 'sess1', cost: { total_cost_usd: 0 } });
    s.addSubagent('sess1', { agent_id: 'agent-1', agent_type: 'Explore' });
    s.data.liveSessions.sess1._activeSubagents['agent-1'].startedAt = Date.now() - 60_000;
    const failuresBefore = s.failureStore.cache.length;
    s.sweepOrphanedSubagents(10_000);
    assert.strictEqual(s.failureStore.cache.length, failuresBefore + 1);
    const record = s.failureStore.cache[s.failureStore.cache.length - 1];
    assert.strictEqual(record.toolName, 'Agent');
    assert.strictEqual(record.eventType, 'subagent_orphaned');
    assert.strictEqual(record.sessionId, 'sess1');
    assert.strictEqual(record.toolInput.agent_id, 'agent-1');
  }, 'sweep-failure');
});

test('sweepOrphanedSubagents: uses _lastToolAt (not startedAt) when present', () => {
  const s = new Store();
  s.updateLiveSession({ session_id: 'sess1', cost: { total_cost_usd: 0 } });
  s.addSubagent('sess1', { agent_id: 'agent-1', agent_type: 'Explore' });
  const agent = s.data.liveSessions.sess1._activeSubagents['agent-1'];
  // Agent started long ago but had a recent tool event — not orphaned
  agent.startedAt = Date.now() - 120_000;
  agent._lastToolAt = Date.now() - 1000;
  const result = s.sweepOrphanedSubagents(10_000);
  assert.strictEqual(result, false);
  assert.ok(s.data.liveSessions.sess1._activeSubagents['agent-1']);
});

test('sweepOrphanedSubagents: emits subagentUpdate event with action:orphan-sweep', async () => {
  await withTmp(async (tmp) => {
    const s = storeWithTmpFailures(tmp);
    s.updateLiveSession({ session_id: 'sess1', cost: { total_cost_usd: 0 } });
    s.addSubagent('sess1', { agent_id: 'agent-1', agent_type: 'Explore' });
    s.data.liveSessions.sess1._activeSubagents['agent-1'].startedAt = Date.now() - 60_000;
    const eventPromise = assertEvent(s, 'subagentUpdate', { predicate: (e) => e.action === 'orphan-sweep' });
    s.sweepOrphanedSubagents(10_000);
    const event = await eventPromise;
    assert.strictEqual(event.sessionId, 'sess1');
    assert.strictEqual(event.action, 'orphan-sweep');
  }, 'sweep-event');
});

// --- config change → failure store ---
test('recordConfigChange: writes a config_change row to failure store', async () => {
  await withTmp(async (tmp) => {
    const s = storeWithTmpFailures(tmp);
    s.updateLiveSession({ session_id: 'cfg1', cost: { total_cost_usd: 0 }, workspace: { current_dir: '/tmp/proj' } });
    s.recordConfigChange('cfg1', {
      config_path: '/home/user/.claude/settings.json',
      changes: { hooks: 'modified', statusLine: 'replaced' },
    });
    const rows = s.failureStore.cache;
    const cfgRow = rows.find((r) => r.eventType === 'config_change');
    assert.ok(cfgRow, 'config_change row should be present');
    assert.strictEqual(cfgRow.toolName, 'Config');
    assert.strictEqual(cfgRow.sessionId, 'cfg1');
    assert.ok(cfgRow.error.includes('settings.json'));
    assert.ok(cfgRow.toolInput.changes.hooks === 'modified');
  }, 'config-change-failure');
});

test('recordConfigChange: still populates session._configChanges', async () => {
  await withTmp(async (tmp) => {
    const s = storeWithTmpFailures(tmp);
    s.updateLiveSession({ session_id: 'cfg2', cost: { total_cost_usd: 0 } });
    s.recordConfigChange('cfg2', { config_path: '/x/settings.json', changes: {} });
    assert.strictEqual(s.data.liveSessions.cfg2._configChanges.length, 1);
  }, 'config-change-session');
});

test('recordConfigChange: emits configChange event', async () => {
  await withTmp(async (tmp) => {
    const s = storeWithTmpFailures(tmp);
    s.updateLiveSession({ session_id: 'cfg3', cost: { total_cost_usd: 0 } });
    const p = assertEvent(s, 'configChange');
    s.recordConfigChange('cfg3', { config_path: '/x/settings.json' });
    const event = await p;
    assert.strictEqual(event.sessionId, 'cfg3');
  }, 'config-change-event');
});

test('recordConfigChange: works even when session is not yet live (failure row still written)', async () => {
  await withTmp(async (tmp) => {
    const s = storeWithTmpFailures(tmp);
    s.recordConfigChange('unknown-session', { config_path: '/x/settings.json' });
    const rows = s.failureStore.cache;
    const cfgRow = rows.find((r) => r.eventType === 'config_change');
    assert.ok(cfgRow, 'failure row written even without live session');
    assert.strictEqual(cfgRow.sessionId, 'unknown-session');
  }, 'config-change-no-session');
});

// --- passive events must not prevent pruning ---
test('recordConfigChange: does not update _lastSeen (passive events must not prevent pruning)', async () => {
  await withTmp(async (tmp) => {
    const s = storeWithTmpFailures(tmp);
    s.updateLiveSession({ session_id: 'cfg-stale', cost: { total_cost_usd: 0 }, workspace: { current_dir: '/tmp' } });
    const staleTime = Date.now() - 3 * 60 * 60 * 1000;
    s.data.liveSessions['cfg-stale']._lastSeen = staleTime;
    s.recordConfigChange('cfg-stale', { config_path: '/x/settings.json', changes: {} });
    assert.strictEqual(s.data.liveSessions['cfg-stale']._lastSeen, staleTime,
      '_lastSeen must not be refreshed by passive ConfigChange');
    s.pruneStale(2 * 60 * 60 * 1000);
    assert.strictEqual(s.data.liveSessions['cfg-stale'], undefined,
      'stale session should be pruned despite recent ConfigChange');
  }, 'config-change-no-lastSeen');
});

test('recordTaskCompleted: does not update _lastSeen (passive events must not prevent pruning)', () => {
  const s = new Store();
  s.updateLiveSession({ session_id: 'task-stale', cost: { total_cost_usd: 0 } });
  const staleTime = Date.now() - 3 * 60 * 60 * 1000;
  s.data.liveSessions['task-stale']._lastSeen = staleTime;
  s.recordTaskCompleted('task-stale', { task_id: 't1', task_description: 'test' });
  assert.strictEqual(s.data.liveSessions['task-stale']._lastSeen, staleTime,
    '_lastSeen must not be refreshed by passive TaskCompleted');
  s.pruneStale(2 * 60 * 60 * 1000);
  assert.strictEqual(s.data.liveSessions['task-stale'], undefined,
    'stale session should be pruned despite recent TaskCompleted');
});

// --- forced-continuation detection (B1′) ---
test('forcedContinuation: tool event after Stop without new prompt records an entry', async () => {
  const s = new Store();
  s.updateLiveSession({ session_id: 'fc1', cost: { total_cost_usd: 0 } });
  s.updatePrompt('fc1', 'do a thing');
  // Stop fires
  s.recordTurnEnd('fc1', {});
  // Tool event arrives without a new UserPromptSubmit in between
  const p = assertEvent(s, 'forcedContinuation');
  s.addToolEvent({ tool_name: 'Read', session_id: 'fc1' });
  const event = await p;
  assert.strictEqual(event.sessionId, 'fc1');
  assert.strictEqual(event.consecutive, 1);
  assert.strictEqual(event.entry.firstTool, 'Read');
  const sess = s.data.liveSessions.fc1;
  assert.strictEqual(sess._forcedContinuations.length, 1);
  assert.strictEqual(sess._consecutiveForcedContinuations, 1);
});

test('forcedContinuation: multiple tool events after a single Stop count as one entry', () => {
  const s = new Store();
  s.updateLiveSession({ session_id: 'fc2', cost: { total_cost_usd: 0 } });
  s.updatePrompt('fc2', 'p');
  s.recordTurnEnd('fc2', {});
  s.addToolEvent({ tool_name: 'Read', session_id: 'fc2' });
  s.addToolEvent({ tool_name: 'Bash', session_id: 'fc2' });
  s.addToolEvent({ tool_name: 'Edit', session_id: 'fc2' });
  const sess = s.data.liveSessions.fc2;
  assert.strictEqual(sess._forcedContinuations.length, 1, 'dedupe per Stop');
  assert.strictEqual(sess._consecutiveForcedContinuations, 1);
});

test('forcedContinuation: new user prompt resets consecutive counter', () => {
  const s = new Store();
  s.updateLiveSession({ session_id: 'fc3', cost: { total_cost_usd: 0 } });
  s.updatePrompt('fc3', 'first');
  s.recordTurnEnd('fc3', {});
  s.addToolEvent({ tool_name: 'Read', session_id: 'fc3' });
  const sess = s.data.liveSessions.fc3;
  assert.strictEqual(sess._consecutiveForcedContinuations, 1);
  // User sends new prompt
  s.updatePrompt('fc3', 'new instruction');
  assert.strictEqual(s.data.liveSessions.fc3._consecutiveForcedContinuations, 0);
  // History total preserved
  assert.strictEqual(s.data.liveSessions.fc3._forcedContinuations.length, 1);
});

test('forcedContinuation: consecutive rejections stack without intervening prompt', () => {
  const s = new Store();
  s.updateLiveSession({ session_id: 'fc4', cost: { total_cost_usd: 0 } });
  s.updatePrompt('fc4', 'p');
  // Stop 1 → tool event → Stop 2 → tool event → Stop 3 → tool event
  s.recordTurnEnd('fc4', {});
  s.addToolEvent({ tool_name: 'Read', session_id: 'fc4' });
  s.recordTurnEnd('fc4', {});
  s.addToolEvent({ tool_name: 'Read', session_id: 'fc4' });
  s.recordTurnEnd('fc4', {});
  s.addToolEvent({ tool_name: 'Read', session_id: 'fc4' });
  const sess = s.data.liveSessions.fc4;
  assert.strictEqual(sess._forcedContinuations.length, 3);
  assert.strictEqual(sess._consecutiveForcedContinuations, 3);
});

test('forcedContinuation: does NOT fire when tool events land BEFORE any Stop', () => {
  const s = new Store();
  s.updateLiveSession({ session_id: 'fc5', cost: { total_cost_usd: 0 } });
  s.updatePrompt('fc5', 'p');
  // Normal flow: user prompt → tools → Stop. No forced continuation.
  s.addToolEvent({ tool_name: 'Read', session_id: 'fc5' });
  s.addToolEvent({ tool_name: 'Bash', session_id: 'fc5' });
  const sess = s.data.liveSessions.fc5;
  assert.ok(!sess._forcedContinuations || sess._forcedContinuations.length === 0);
});

test('forcedContinuation: does NOT fire if no prior UserPromptSubmit was ever recorded', () => {
  // Guards against false-positive on hook-forwarder-less environments where
  // UserPromptSubmit hook isn't installed — we have no baseline to compare to.
  const s = new Store();
  s.updateLiveSession({ session_id: 'fc6', cost: { total_cost_usd: 0 } });
  s.recordTurnEnd('fc6', {});
  s.addToolEvent({ tool_name: 'Read', session_id: 'fc6' });
  const sess = s.data.liveSessions.fc6;
  assert.ok(!sess._forcedContinuations || sess._forcedContinuations.length === 0);
  assert.strictEqual(sess._consecutiveForcedContinuations || 0, 0);
});

// --- C1: per-agent failure tally ---
test('C1 addToolEvent: agent failure increments _failureCount + stashes _lastError', () => {
  const s = new Store();
  s.updateLiveSession({ session_id: 's', cost: { total_cost_usd: 0 } });
  s.addSubagent('s', { agent_id: 'a1', agent_type: 'Explore' });
  s.addToolEvent({ tool_name: 'Read', session_id: 's', agent_id: 'a1', success: false, error: 'ENOENT' });
  const agent = s.data.liveSessions.s._activeSubagents.a1;
  assert.strictEqual(agent._failureCount, 1);
  assert.strictEqual(agent._lastError, 'ENOENT');
});

test('C1 addToolEvent: validation_block does NOT inflate _failureCount', () => {
  const s = new Store();
  s.updateLiveSession({ session_id: 's', cost: { total_cost_usd: 0 } });
  s.addSubagent('s', { agent_id: 'a1', agent_type: 'Explore' });
  s.addToolEvent({ tool_name: 'Bash', session_id: 's', agent_id: 'a1', success: false, event_type: 'validation_block', error: 'blocked' });
  const agent = s.data.liveSessions.s._activeSubagents.a1;
  assert.strictEqual(agent._failureCount, 0);
  assert.strictEqual(agent._validationBlockCount, 1);
});

test('C1 removeSubagent: failureCount + lastError carry into history entry', () => {
  const s = new Store();
  s.updateLiveSession({ session_id: 's', cost: { total_cost_usd: 0 } });
  s.addSubagent('s', { agent_id: 'a1', agent_type: 'Explore' });
  s.addToolEvent({ tool_name: 'Read', session_id: 's', agent_id: 'a1', success: false, error: 'ENOENT' });
  s.addToolEvent({ tool_name: 'Read', session_id: 's', agent_id: 'a1', success: false, error: 'EACCES' });
  s.removeSubagent('s', { agent_id: 'a1', agent_type: 'Explore' });
  const hist = s.data.liveSessions.s._subagentHistory;
  assert.strictEqual(hist[0].failureCount, 2);
  assert.strictEqual(hist[0].lastError, 'EACCES');
});

// --- C3: per-agent validation-block tally ---
test('C3 addToolEvent: validation_block increments _validationBlockCount', () => {
  const s = new Store();
  s.updateLiveSession({ session_id: 's', cost: { total_cost_usd: 0 } });
  s.addSubagent('s', { agent_id: 'a1', agent_type: 'Explore' });
  s.addToolEvent({ tool_name: 'Bash', session_id: 's', agent_id: 'a1', success: false, event_type: 'validation_block', error: '[BLOCK] cat' });
  s.addToolEvent({ tool_name: 'Bash', session_id: 's', agent_id: 'a1', success: false, event_type: 'validation_block', error: '[BLOCK] grep' });
  const agent = s.data.liveSessions.s._activeSubagents.a1;
  assert.strictEqual(agent._validationBlockCount, 2);
});

test('C3 removeSubagent: validationBlockCount carries into history entry', () => {
  const s = new Store();
  s.updateLiveSession({ session_id: 's', cost: { total_cost_usd: 0 } });
  s.addSubagent('s', { agent_id: 'a1', agent_type: 'Explore' });
  s.addToolEvent({ tool_name: 'Bash', session_id: 's', agent_id: 'a1', success: false, event_type: 'validation_block' });
  s.removeSubagent('s', { agent_id: 'a1', agent_type: 'Explore' });
  assert.strictEqual(s.data.liveSessions.s._subagentHistory[0].validationBlockCount, 1);
});

// --- C2: transcript-parse status ---
test('C2 removeSubagent: transcriptStatus:ok when metrics.status is ok', () => {
  const s = new Store();
  s.updateLiveSession({ session_id: 's', cost: { total_cost_usd: 0 } });
  s.addSubagent('s', { agent_id: 'a1', agent_type: 'Explore' });
  s.removeSubagent('s', {
    agent_id: 'a1',
    _transcriptMetrics: {
      status: 'ok',
      tokens: { input: 1000, output: 200, total: 1200 },
      cost: { total_cost_usd: 0.05 },
      model: { display_name: 'Haiku' },
    },
  });
  assert.strictEqual(s.data.liveSessions.s._subagentHistory[0].transcriptStatus, 'ok');
});

test('C2 removeSubagent: transcriptStatus:missing when metrics.status:missing', () => {
  const s = new Store();
  s.updateLiveSession({ session_id: 's', cost: { total_cost_usd: 0 } });
  s.addSubagent('s', { agent_id: 'a1', agent_type: 'Explore' });
  s.removeSubagent('s', {
    agent_id: 'a1',
    _transcriptMetrics: { status: 'missing' },
  });
  assert.strictEqual(s.data.liveSessions.s._subagentHistory[0].transcriptStatus, 'missing');
  assert.strictEqual(s.data.liveSessions.s._subagentHistory[0].tokens, null);
  assert.strictEqual(s.data.liveSessions.s._subagentHistory[0].cost, null);
});

test('C2 removeSubagent: transcriptStatus:parse_failed when metrics.status:parse_failed', () => {
  const s = new Store();
  s.updateLiveSession({ session_id: 's', cost: { total_cost_usd: 0 } });
  s.addSubagent('s', { agent_id: 'a1', agent_type: 'Explore' });
  s.removeSubagent('s', {
    agent_id: 'a1',
    _transcriptMetrics: { status: 'parse_failed' },
  });
  assert.strictEqual(s.data.liveSessions.s._subagentHistory[0].transcriptStatus, 'parse_failed');
});

test('C2 sweepOrphanedSubagents: orphaned history entry has transcriptStatus:missing', async () => {
  await withTmp(async (tmp) => {
    const s = storeWithTmpFailures(tmp);
    s.updateLiveSession({ session_id: 's', cost: { total_cost_usd: 0 } });
    s.addSubagent('s', { agent_id: 'a1', agent_type: 'Explore' });
    s.data.liveSessions.s._activeSubagents.a1.startedAt = Date.now() - 60_000;
    s.sweepOrphanedSubagents(10_000);
    const hist = s.data.liveSessions.s._subagentHistory;
    assert.strictEqual(hist[0].status, 'orphaned');
    assert.strictEqual(hist[0].transcriptStatus, 'missing');
  }, 'c2-orphan');
});

// --- E1: parent/child subagent linkage ---
test('E1 addSubagent: stamps parentAgentId when passed', () => {
  const s = new Store();
  s.updateLiveSession({ session_id: 's', cost: { total_cost_usd: 0 } });
  s.addSubagent('s', { agent_id: 'parent-1', agent_type: 'facilitator' });
  s.addSubagent('s', { agent_id: 'child-1', agent_type: 'Explore', parent_agent_id: 'parent-1' });
  const child = s.data.liveSessions.s._activeSubagents['child-1'];
  assert.strictEqual(child.parentAgentId, 'parent-1');
});

test('E1 addSubagent: parentAgentId null when not provided', () => {
  const s = new Store();
  s.updateLiveSession({ session_id: 's', cost: { total_cost_usd: 0 } });
  s.addSubagent('s', { agent_id: 'orphan-root', agent_type: 'Explore' });
  const agent = s.data.liveSessions.s._activeSubagents['orphan-root'];
  assert.strictEqual(agent.parentAgentId, null);
});

test('E1 removeSubagent: parentAgentId carries into history entry', () => {
  const s = new Store();
  s.updateLiveSession({ session_id: 's', cost: { total_cost_usd: 0 } });
  s.addSubagent('s', { agent_id: 'child-2', agent_type: 'Explore', parent_agent_id: 'parent-2' });
  s.removeSubagent('s', { agent_id: 'child-2' });
  const hist = s.data.liveSessions.s._subagentHistory;
  assert.strictEqual(hist[0].parentAgentId, 'parent-2');
});

test('getSnapshot includes statusLineState', () => {
  const s = new Store();
  const snap = s.getSnapshot();
  assert.ok('statusLineState' in snap);
  assert.ok('toolEvents' in snap);
  assert.ok('liveSessions' in snap);
});

// ── V2 — Agent prompt, live metrics, permission mode ─────────

test('V2 addSubagent: stores prompt and agentTranscriptPath', () => {
  const s = new Store();
  s.updateLiveSession({ session_id: 's', cost: { total_cost_usd: 0 } });
  s.addSubagent('s', {
    agent_id: 'a1', agent_type: 'Explore',
    prompt: 'Find all test files',
    agent_transcript_path: '/tmp/subagents/agent-a1.jsonl',
  });
  const agent = s.data.liveSessions.s._activeSubagents.a1;
  assert.strictEqual(agent.prompt, 'Find all test files');
  assert.strictEqual(agent.agentTranscriptPath, '/tmp/subagents/agent-a1.jsonl');
  assert.strictEqual(agent._liveCost, null);
  assert.strictEqual(agent._liveContextPct, null);
});

test('V2 addToolEvent: updates agent live metrics from _agentLiveMetrics', () => {
  const s = new Store();
  s.updateLiveSession({ session_id: 's', cost: { total_cost_usd: 0 } });
  s.addSubagent('s', { agent_id: 'a1', agent_type: 'Explore' });
  s.addToolEvent({
    tool_name: 'Read', session_id: 's', agent_id: 'a1', agent_type: 'Explore',
    _agentLiveMetrics: {
      model: { id: 'claude-haiku-4-5-20251001', display_name: 'Haiku' },
      cost: { total_cost_usd: 0.0523 },
      context_window: { used_percentage: 34, total_input_tokens: 14800 },
      _modelCosts: { 'claude-haiku-4-5-20251001': { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, count: 3 } },
    },
  });
  const agent = s.data.liveSessions.s._activeSubagents.a1;
  assert.strictEqual(agent._liveCost, 0.0523);
  assert.strictEqual(agent._liveContextPct, 34);
  assert.strictEqual(agent._liveContextTokens, 14800);
  assert.strictEqual(agent._liveModel, 'Haiku');
  assert.strictEqual(agent._liveTurns, 3);
});

test('V2 removeSubagent: carries prompt and permissionMode into history', () => {
  const s = new Store();
  s.updateLiveSession({ session_id: 's', cost: { total_cost_usd: 0 } });
  s.addSubagent('s', { agent_id: 'a1', agent_type: 'Explore', prompt: 'Find files' });
  s.removeSubagent('s', { agent_id: 'a1', permission_mode: 'plan' });
  const hist = s.data.liveSessions.s._subagentHistory;
  assert.strictEqual(hist[0].prompt, 'Find files');
  assert.strictEqual(hist[0].permissionMode, 'plan');
});

test('V2 removeSubagent missing-start: prompt and permissionMode from data', () => {
  const s = new Store();
  s.updateLiveSession({ session_id: 's', cost: { total_cost_usd: 0 } });
  // No addSubagent — simulate missed SubagentStart
  s.removeSubagent('s', {
    agent_id: 'a1', agent_type: 'Explore',
    prompt: 'fallback prompt', permission_mode: 'default',
  });
  const hist = s.data.liveSessions.s._subagentHistory;
  assert.strictEqual(hist[0].prompt, 'fallback prompt');
  assert.strictEqual(hist[0].permissionMode, 'default');
});

test('V2 sweepOrphanedSubagents: carries prompt into orphaned history', () => {
  const s = new Store();
  s.updateLiveSession({ session_id: 's', cost: { total_cost_usd: 0 } });
  s.addSubagent('s', { agent_id: 'a1', agent_type: 'Explore', prompt: 'orphan prompt' });
  const agent = s.data.liveSessions.s._activeSubagents.a1;
  agent.startedAt = Date.now() - 700_000; // 11+ min ago
  agent._lastToolAt = null;
  s.sweepOrphanedSubagents(600_000);
  const hist = s.data.liveSessions.s._subagentHistory;
  assert.strictEqual(hist[0].prompt, 'orphan prompt');
  assert.strictEqual(hist[0].status, 'orphaned');
});

summary();

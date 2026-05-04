/**
 * Integration tests for the subagent-orphan detection + compaction crossover
 * pipeline. Exercises the real HTTP endpoints end-to-end.
 *
 * Flow under test:
 *   POST /api/subagent (start) → active agent in snapshot
 *   POST /api/compact        → _spannedCompactAt stamped on active agents
 *   sweepOrphanedSubagents    → agent moves to history.status=orphaned
 *                               AND a failure row lands in telemetry-failures.jsonl
 */
import assert from 'assert';
import { mkdirSync, copyFileSync, readFileSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { test, summary } from '../helpers/test-harness.js';
import { withTmp } from '../helpers/tmp.js';
import { startTestServer, getJson, postJson } from '../helpers/server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'fixtures');

console.log('subagent-orphan integration tests:\n');

async function withTestServer(fn) {
  await withTmp(async (home) => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    copyFileSync(join(FIXTURES, 'settings/healthy.json'), join(home, '.claude', 'settings.json'));
    const srv = await startTestServer({
      tmpHome: home,
      extraEnv: { RH_TELEMETRY_TEST_MODE: '1' },
    });
    try {
      await fn(srv, home);
    } finally {
      await srv.stop();
    }
  }, 'orphan');
}

test('POST /api/subagent action=start creates an active subagent with _lastToolAt=null', async () => {
  await withTestServer(async (srv) => {
    await postJson(srv.baseUrl + '/api/subagent', {
      session_id: 'sess-1',
      action: 'start',
      agent_id: 'agent-1',
      agent_type: 'Explore',
    });
    const snap = await getJson(srv.baseUrl + '/api/snapshot');
    const live = snap.liveSessions['sess-1'];
    assert.ok(live, 'live session should exist');
    const agent = live._activeSubagents['agent-1'];
    assert.ok(agent, 'agent-1 should be active');
    assert.strictEqual(agent.type, 'Explore');
    assert.strictEqual(agent._lastToolAt, null);
    assert.strictEqual(agent._spannedCompactAt, null);
  });
});

test('POST /api/hooks with agent_id stamps _lastToolAt on the active subagent', async () => {
  await withTestServer(async (srv) => {
    await postJson(srv.baseUrl + '/api/subagent', {
      session_id: 'sess-1',
      action: 'start',
      agent_id: 'agent-1',
      agent_type: 'Explore',
    });
    const before = Date.now();
    await postJson(srv.baseUrl + '/api/hooks', {
      tool_name: 'Read',
      session_id: 'sess-1',
      agent_id: 'agent-1',
      event_type: 'post_tool_use',
    });
    const snap = await getJson(srv.baseUrl + '/api/snapshot');
    const agent = snap.liveSessions['sess-1']._activeSubagents['agent-1'];
    assert.ok(agent._lastToolAt >= before, `_lastToolAt (${agent._lastToolAt}) should be >= ${before}`);
    assert.strictEqual(agent._toolCount, 1);
    assert.strictEqual(agent._lastTool, 'Read');
  });
});

test('POST /api/compact stamps _spannedCompactAt on all active subagents for that session', async () => {
  await withTestServer(async (srv) => {
    await postJson(srv.baseUrl + '/api/subagent', {
      session_id: 'sess-1', action: 'start', agent_id: 'agent-1', agent_type: 'Explore',
    });
    await postJson(srv.baseUrl + '/api/subagent', {
      session_id: 'sess-1', action: 'start', agent_id: 'agent-2', agent_type: 'facilitator',
    });
    await postJson(srv.baseUrl + '/api/compact', { session_id: 'sess-1', trigger: 'auto' });
    const snap = await getJson(srv.baseUrl + '/api/snapshot');
    const active = snap.liveSessions['sess-1']._activeSubagents;
    assert.strictEqual(active['agent-1']._spannedCompactAt.length, 1);
    assert.strictEqual(active['agent-2']._spannedCompactAt.length, 1);
  });
});

test('sweepOrphanedSubagents (via _test endpoint) moves stale agent to history + writes failure row', async () => {
  await withTestServer(async (srv, home) => {
    // Start the subagent through the real public endpoint
    await postJson(srv.baseUrl + '/api/subagent', {
      session_id: 'sess-orphan', action: 'start', agent_id: 'zombie-1', agent_type: 'Explore',
    });

    // Wait past the orphan threshold (use a short 100ms for the test)
    await new Promise((r) => setTimeout(r, 150));

    // Trigger the sweep via the test-mode endpoint with a 100ms threshold
    const res = await postJson(srv.baseUrl + '/api/_test/state', {
      method: 'sweepOrphanedSubagents',
      args: [100],
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.result, true, 'sweep should report it moved something');

    // Confirm the snapshot: agent gone from active, present in history as orphaned
    const snap = await getJson(srv.baseUrl + '/api/snapshot');
    const live = snap.liveSessions['sess-orphan'];
    assert.strictEqual(Object.keys(live._activeSubagents).length, 0, 'active should be empty');
    assert.ok(live._subagentHistory.length >= 1, 'history should have at least one entry');
    const orphan = live._subagentHistory.find((h) => h.agentId === 'zombie-1');
    assert.ok(orphan, 'zombie-1 should be in history');
    assert.strictEqual(orphan.status, 'orphaned');
    assert.ok(orphan.orphanedAfterMs >= 100);

    // Confirm the failure row landed in the JSONL on disk
    const failurePath = join(home, '.claude', 'telemetry-failures.jsonl');
    assert.ok(existsSync(failurePath), 'failure log file should exist');
    const content = readFileSync(failurePath, 'utf-8');
    const lines = content.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const orphanRow = lines.find((r) => r.eventType === 'subagent_orphaned' && r.toolInput?.agent_id === 'zombie-1');
    assert.ok(orphanRow, 'subagent_orphaned failure row should be persisted');
    assert.strictEqual(orphanRow.toolName, 'Agent');
    assert.strictEqual(orphanRow.sessionId, 'sess-orphan');
  });
});

test('orphan sweep + compact: orphaned agent in history carries spannedCompactAt through', async () => {
  await withTestServer(async (srv) => {
    await postJson(srv.baseUrl + '/api/subagent', {
      session_id: 'sess-mix', action: 'start', agent_id: 'mixed-1', agent_type: 'facilitator',
    });
    await postJson(srv.baseUrl + '/api/compact', { session_id: 'sess-mix', trigger: 'auto' });
    await new Promise((r) => setTimeout(r, 150));

    await postJson(srv.baseUrl + '/api/_test/state', {
      method: 'sweepOrphanedSubagents',
      args: [100],
    });

    const snap = await getJson(srv.baseUrl + '/api/snapshot');
    const hist = snap.liveSessions['sess-mix']._subagentHistory;
    const orphan = hist.find((h) => h.agentId === 'mixed-1');
    assert.ok(orphan);
    assert.strictEqual(orphan.status, 'orphaned');
    assert.ok(Array.isArray(orphan.spannedCompactAt));
    assert.strictEqual(orphan.spannedCompactAt.length, 1);
  });
});

summary();

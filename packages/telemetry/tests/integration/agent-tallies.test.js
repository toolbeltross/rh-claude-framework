/**
 * Integration tests for Phase C1/C2/C3:
 * - C1: per-agent failure tally propagates to snapshot
 * - C2: subagent-stop with missing transcript yields transcriptStatus
 * - C3: validation_block with agent_id attributes to the agent
 */
import assert from 'assert';
import { mkdirSync, copyFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { test, summary } from '../helpers/test-harness.js';
import { withTmp } from '../helpers/tmp.js';
import { startTestServer, getJson, postJson } from '../helpers/server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'fixtures');

console.log('agent-tallies integration tests:\n');

async function withServer(fn) {
  await withTmp(async (home) => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    copyFileSync(join(FIXTURES, 'settings/healthy.json'), join(home, '.claude', 'settings.json'));
    const srv = await startTestServer({ tmpHome: home });
    try {
      await fn(srv, home);
    } finally {
      await srv.stop();
    }
  }, 'agent-tallies');
}

async function seed(srv, sessionId) {
  await postJson(srv.baseUrl + '/api/status', {
    session_id: sessionId,
    model: { id: 'claude-opus-4-6', display_name: 'Opus 4.6' },
    cost: { total_cost_usd: 0.5 },
    context_window: { context_window_size: 200000, total_input_tokens: 5000, used_percentage: 3 },
    workspace: { current_dir: '/tmp/tal' },
    _source: 'statusLine',
  });
  await postJson(srv.baseUrl + '/api/subagent', {
    session_id: sessionId,
    action: 'start',
    agent_id: 'a1',
    agent_type: 'Explore',
  });
}

test('C1: per-agent failure count visible on snapshot after PostToolUseFailure', async () => {
  await withServer(async (srv) => {
    const sid = 'c1-sess';
    await seed(srv, sid);
    await postJson(srv.baseUrl + '/api/hooks', {
      tool_name: 'Read',
      session_id: sid,
      agent_id: 'a1',
      event_type: 'post_tool_use_failure',
      success: false,
      error: 'ENOENT: no such file',
    });
    await new Promise((r) => setTimeout(r, 80));
    const snap = await getJson(srv.baseUrl + '/api/snapshot');
    const agent = snap.liveSessions[sid]._activeSubagents.a1;
    assert.strictEqual(agent._failureCount, 1);
    assert.ok(String(agent._lastError).includes('ENOENT'));
  });
});

test('C2: subagent-stop with no _transcriptMetrics yields transcriptStatus:missing on history', async () => {
  await withServer(async (srv) => {
    const sid = 'c2-sess';
    await seed(srv, sid);
    await postJson(srv.baseUrl + '/api/subagent', {
      session_id: sid,
      action: 'stop',
      agent_id: 'a1',
      agent_type: 'Explore',
      // No _transcriptMetrics — simulates a missing transcript path
    });
    await new Promise((r) => setTimeout(r, 80));
    const snap = await getJson(srv.baseUrl + '/api/snapshot');
    const hist = snap.liveSessions[sid]._subagentHistory;
    assert.strictEqual(hist.length, 1);
    // With no metrics provided at all, fallback yields 'missing'
    assert.strictEqual(hist[0].transcriptStatus, 'missing');
  });
});

test('C2: subagent-stop with metrics.status=parse_failed carries through to history', async () => {
  await withServer(async (srv) => {
    const sid = 'c2-pf';
    await seed(srv, sid);
    await postJson(srv.baseUrl + '/api/subagent', {
      session_id: sid,
      action: 'stop',
      agent_id: 'a1',
      agent_type: 'Explore',
      _transcriptMetrics: { status: 'parse_failed', error: 'bad json on line 5' },
    });
    await new Promise((r) => setTimeout(r, 80));
    const snap = await getJson(srv.baseUrl + '/api/snapshot');
    assert.strictEqual(snap.liveSessions[sid]._subagentHistory[0].transcriptStatus, 'parse_failed');
  });
});

test('C3: validation_block with agent_id increments agent _validationBlockCount (not _failureCount)', async () => {
  await withServer(async (srv) => {
    const sid = 'c3-sess';
    await seed(srv, sid);
    await postJson(srv.baseUrl + '/api/hooks', {
      tool_name: 'Bash',
      session_id: sid,
      agent_id: 'a1',
      event_type: 'validation_block',
      success: false,
      error: '[BLOCK] cat is not allowed',
    });
    await new Promise((r) => setTimeout(r, 80));
    const snap = await getJson(srv.baseUrl + '/api/snapshot');
    const agent = snap.liveSessions[sid]._activeSubagents.a1;
    assert.strictEqual(agent._validationBlockCount, 1);
    assert.strictEqual(agent._failureCount, 0, 'validation_block must not pollute failure count');
  });
});

summary();

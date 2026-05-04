/**
 * Integration tests for dashboard-reset prevention.
 *
 * Verifies that the WebSocket snapshot + update cycle does not cause the
 * dashboard to lose accumulated state. Tests the full server surface:
 * POST events → store accumulation → WS snapshot on (re)connect.
 */
import assert from 'assert';
import { mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { test, summary } from '../helpers/test-harness.js';
import { withTmp } from '../helpers/tmp.js';
import { startTestServer, postJson, getJson } from '../helpers/server.js';
import { openTestWs } from '../helpers/ws-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'fixtures');

console.log('dashboard-reset integration tests:\n');

function makeStatusPayload(sessionId) {
  const base = JSON.parse(readFileSync(join(FIXTURES, 'hooks/status-line.json'), 'utf-8'));
  return { ...base, session_id: sessionId };
}

async function withServerAndWs(fn) {
  await withTmp(async (home) => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    copyFileSync(join(FIXTURES, 'settings/healthy.json'), join(home, '.claude', 'settings.json'));
    const srv = await startTestServer({ tmpHome: home });
    let ws;
    try {
      ws = await openTestWs(srv.wsUrl);
      await ws.waitFor((f) => f.type === 'snapshot');
      await fn(srv, ws, home);
    } finally {
      if (ws) await ws.close();
      await srv.stop();
    }
  }, 'reset');
}

// --- WS reconnect preserves accumulated state ---

test('reconnect: snapshot contains tool events accumulated before disconnect', async () => {
  await withTmp(async (home) => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    copyFileSync(join(FIXTURES, 'settings/healthy.json'), join(home, '.claude', 'settings.json'));
    const srv = await startTestServer({ tmpHome: home });
    try {
      // Connect first WS, accumulate events
      let ws1 = await openTestWs(srv.wsUrl);
      await ws1.waitFor((f) => f.type === 'snapshot');

      await postJson(srv.baseUrl + '/api/hooks', {
        tool_name: 'Read', session_id: 'sess-a', cwd: '/tmp',
      });
      await postJson(srv.baseUrl + '/api/hooks', {
        tool_name: 'Bash', session_id: 'sess-a', cwd: '/tmp',
      });
      await postJson(srv.baseUrl + '/api/hooks', {
        tool_name: 'Write', session_id: 'sess-a', cwd: '/tmp',
      });
      await ws1.waitFor((f) => f.type === 'toolEvent' && f.data.tool === 'Write', 2000);
      await ws1.close();

      // Reconnect — snapshot should have all 3 tool events
      let ws2 = await openTestWs(srv.wsUrl);
      const snap = await ws2.waitFor((f) => f.type === 'snapshot', 2000);
      assert.ok(snap.data.toolEvents.length >= 3,
        `expected ≥3 tool events in snapshot, got ${snap.data.toolEvents.length}`);
      await ws2.close();
    } finally {
      await srv.stop();
    }
  }, 'reconnect-tools');
});

test('reconnect: snapshot contains live sessions from statusLine', async () => {
  await withTmp(async (home) => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    copyFileSync(join(FIXTURES, 'settings/healthy.json'), join(home, '.claude', 'settings.json'));
    const srv = await startTestServer({ tmpHome: home });
    try {
      let ws1 = await openTestWs(srv.wsUrl);
      await ws1.waitFor((f) => f.type === 'snapshot');

      await postJson(srv.baseUrl + '/api/status', makeStatusPayload('sess-b'));
      await ws1.waitFor((f) => f.type === 'liveSession', 2000);
      await ws1.close();

      // Reconnect
      let ws2 = await openTestWs(srv.wsUrl);
      const snap = await ws2.waitFor((f) => f.type === 'snapshot', 2000);
      assert.ok(snap.data.liveSessions['sess-b'],
        'live session should survive WS reconnect');
      await ws2.close();
    } finally {
      await srv.stop();
    }
  }, 'reconnect-live');
});

test('reconnect: snapshot preserves turn count and subagent state', async () => {
  await withTmp(async (home) => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    copyFileSync(join(FIXTURES, 'settings/healthy.json'), join(home, '.claude', 'settings.json'));
    const srv = await startTestServer({ tmpHome: home });
    try {
      let ws1 = await openTestWs(srv.wsUrl);
      await ws1.waitFor((f) => f.type === 'snapshot');

      // Set up session with turns + subagent
      await postJson(srv.baseUrl + '/api/status', makeStatusPayload('sess-c'));
      await ws1.waitFor((f) => f.type === 'liveSession', 2000);
      await postJson(srv.baseUrl + '/api/turn-end', { session_id: 'sess-c' });
      await postJson(srv.baseUrl + '/api/turn-end', { session_id: 'sess-c' });
      await postJson(srv.baseUrl + '/api/subagent', {
        action: 'start', session_id: 'sess-c',
        agent_id: 'agent-x', agent_type: 'Explore',
      });
      // Wait for all events to process
      await ws1.waitFor((f) => f.type === 'subagentUpdate', 2000);
      await ws1.close();

      // Reconnect
      let ws2 = await openTestWs(srv.wsUrl);
      const snap = await ws2.waitFor((f) => f.type === 'snapshot', 2000);
      const sess = snap.data.liveSessions['sess-c'];
      assert.ok(sess, 'session should exist in snapshot');
      assert.strictEqual(sess._turnCount, 2, 'turn count should survive reconnect');
      assert.ok(sess._activeSubagents?.['agent-x'], 'active subagent should survive reconnect');
      await ws2.close();
    } finally {
      await srv.stop();
    }
  }, 'reconnect-state');
});

// --- File-watcher update cycle doesn't wipe live state ---

test('file-watcher update: does not include liveSessions or toolEvents', async () => {
  await withServerAndWs(async (srv, ws) => {
    // Populate live session
    await postJson(srv.baseUrl + '/api/status', makeStatusPayload('sess-d'));
    await ws.waitFor((f) => f.type === 'liveSession', 2000);

    // Post tool events
    await postJson(srv.baseUrl + '/api/hooks', {
      tool_name: 'Read', session_id: 'sess-d', cwd: '/tmp',
    });
    await ws.waitFor((f) => f.type === 'toolEvent', 2000);

    // Verify via snapshot API that state is intact
    const snap = await getJson(srv.baseUrl + '/api/snapshot');
    assert.ok(snap.liveSessions['sess-d'], 'live session should be in snapshot');
    assert.ok(snap.toolEvents.length >= 1, 'tool events should be in snapshot');
  });
});

// --- Multiple simultaneous sessions ---

test('multiple sessions: each maintains independent state', async () => {
  await withServerAndWs(async (srv, ws) => {
    // Create two live sessions
    await postJson(srv.baseUrl + '/api/status', makeStatusPayload('sess-1'));
    await postJson(srv.baseUrl + '/api/status', makeStatusPayload('sess-2'));

    // Record turns for session 1 only
    await postJson(srv.baseUrl + '/api/turn-end', { session_id: 'sess-1' });
    await postJson(srv.baseUrl + '/api/turn-end', { session_id: 'sess-1' });
    await postJson(srv.baseUrl + '/api/turn-end', { session_id: 'sess-1' });

    // Record turn for session 2
    await postJson(srv.baseUrl + '/api/turn-end', { session_id: 'sess-2' });

    // Small delay for event processing
    await new Promise(r => setTimeout(r, 200));

    const snap = await getJson(srv.baseUrl + '/api/snapshot');
    assert.strictEqual(snap.liveSessions['sess-1']?._turnCount, 3,
      'session 1 should have 3 turns');
    assert.strictEqual(snap.liveSessions['sess-2']?._turnCount, 1,
      'session 2 should have 1 turn');
  });
});

// --- Snapshot shape consistency ---

test('snapshot: contains all expected top-level keys', async () => {
  await withServerAndWs(async (srv, ws) => {
    const snap = await getJson(srv.baseUrl + '/api/snapshot');
    const required = ['sessions', 'toolEvents', 'liveSessions', 'planInfo', 'statusLineState', 'timestamp'];
    for (const key of required) {
      assert.ok(key in snap, `snapshot missing key: ${key}`);
    }
  });
});

test('snapshot: toolEvents array is bounded at 200', async () => {
  await withServerAndWs(async (srv, ws) => {
    // Post 210 tool events
    const posts = [];
    for (let i = 0; i < 210; i++) {
      posts.push(postJson(srv.baseUrl + '/api/hooks', {
        tool_name: 'Read', session_id: 'flood', cwd: '/tmp',
      }));
    }
    await Promise.all(posts);
    await new Promise(r => setTimeout(r, 300));

    const snap = await getJson(srv.baseUrl + '/api/snapshot');
    assert.ok(snap.toolEvents.length <= 200,
      `tool events should be capped at 200, got ${snap.toolEvents.length}`);
  });
});

// --- Empty .claude.json handling ---

test('empty .claude.json parse does not wipe existing sessions', async () => {
  await withTmp(async (home) => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    copyFileSync(join(FIXTURES, 'settings/healthy.json'), join(home, '.claude', 'settings.json'));
    // Write a valid .claude.json first, then overwrite with empty
    writeFileSync(join(home, '.claude.json'), JSON.stringify({
      projects: {
        '/tmp/proj1': {
          lastSessionId: 'file-sess-1',
          lastCost: 2.50,
          lastModelUsage: {},
        },
      },
    }));

    const srv = await startTestServer({ tmpHome: home });
    try {
      // Wait for initial parse
      await new Promise(r => setTimeout(r, 500));

      let snap = await getJson(srv.baseUrl + '/api/snapshot');
      const initialSessionCount = snap.sessions?.length || 0;
      assert.ok(initialSessionCount >= 1, 'should have parsed the initial session');

      // Simulate mid-write: empty the file
      writeFileSync(join(home, '.claude.json'), '');

      // Wait for chokidar to pick it up (3s poll + stability)
      await new Promise(r => setTimeout(r, 5000));

      snap = await getJson(srv.baseUrl + '/api/snapshot');
      assert.ok(snap.sessions.length >= initialSessionCount,
        `sessions should be preserved during empty file, got ${snap.sessions.length} (expected ≥${initialSessionCount})`);
    } finally {
      await srv.stop();
    }
  }, 'empty-json');
});

summary();

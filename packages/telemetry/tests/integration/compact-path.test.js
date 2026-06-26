/**
 * Integration tests for the PreCompact → /api/compact → store → WS path.
 *
 * Covers the end-to-end plumbing that went silently untested for weeks.
 * Specifically guards against finding #3: if a PreCompact event arrives
 * before the session has a live entry (no prior statusLine or tool event),
 * the compaction used to be dropped on the floor. These tests spin up a
 * real server, fire real POSTs in both orderings, and assert both the
 * snapshot state and the WebSocket broadcast.
 */
import assert from 'assert';
import { mkdirSync, copyFileSync, readFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { test, summary } from '../helpers/test-harness.js';
import { withTmp } from '../helpers/tmp.js';
import { startTestServer, postJson, getJson } from '../helpers/server.js';
import { openTestWs } from '../helpers/ws-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'fixtures');

console.log('compact-path integration tests:\n');

async function withServerAndWs(fn) {
  await withTmp(async (home) => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    copyFileSync(join(FIXTURES, 'settings/healthy.json'), join(home, '.claude', 'settings.json'));
    const srv = await startTestServer({ tmpHome: home });
    let ws;
    try {
      ws = await openTestWs(srv.wsUrl);
      await fn(srv, ws, home);
    } finally {
      if (ws) await ws.close();
      await srv.stop();
    }
  }, 'compact-path');
}

test('status then compact: snapshot and WS both record the compaction', async () => {
  await withServerAndWs(async (srv, ws) => {
    await ws.waitFor((f) => f.type === 'snapshot');
    const payload = JSON.parse(readFileSync(join(FIXTURES, 'hooks/status-line.json'), 'utf-8'));
    await postJson(srv.baseUrl + '/api/status', payload);

    await postJson(srv.baseUrl + '/api/compact', {
      session_id: payload.session_id,
      trigger: 'auto',
    });

    const frame = await ws.waitFor((f) => f.type === 'compactEvent', 2000);
    assert.strictEqual(frame.data.sessionId, payload.session_id);
    assert.strictEqual(frame.data.trigger, 'auto');

    const snap = await getJson(srv.baseUrl + '/api/snapshot');
    const live = snap.liveSessions[payload.session_id];
    assert.ok(live, 'live session should exist');
    assert.strictEqual(live._compactEvents.length, 1);
    assert.ok(live._lastCompactAt, '_lastCompactAt should be set');
  });
});

test('compact BEFORE status: thin session is minted and later merged', async () => {
  // Guards finding #3. Pre-fix behavior: recordCompact returned silently
  // when no session existed. Post-fix: mints a thin entry so the event
  // survives, and a later statusLine post merges cleanly into it.
  await withServerAndWs(async (srv, ws) => {
    await ws.waitFor((f) => f.type === 'snapshot');
    const sid = 'compact-before-anything';

    await postJson(srv.baseUrl + '/api/compact', {
      session_id: sid,
      trigger: 'manual',
    });

    const frame = await ws.waitFor((f) => f.type === 'compactEvent', 2000);
    assert.strictEqual(frame.data.sessionId, sid);

    const snap1 = await getJson(srv.baseUrl + '/api/snapshot');
    const live1 = snap1.liveSessions[sid];
    assert.ok(live1, 'thin live session should be minted');
    assert.strictEqual(live1._compactEvents.length, 1);
    assert.strictEqual(live1._fromCompactEvent, true);

    // Now a real statusLine post arrives — compact history must survive.
    const payload = JSON.parse(readFileSync(join(FIXTURES, 'hooks/status-line.json'), 'utf-8'));
    payload.session_id = sid;
    await postJson(srv.baseUrl + '/api/status', payload);

    const snap2 = await getJson(srv.baseUrl + '/api/snapshot');
    const live2 = snap2.liveSessions[sid];
    assert.ok(live2);
    assert.strictEqual(
      live2._compactEvents.length,
      1,
      'compact event recorded before statusLine must be preserved across update',
    );
    assert.ok(live2.model, 'statusLine data should be merged in');
  });
});

test('used_percentage is recomputed for 1M-context sessions in snapshot', async () => {
  // End-to-end proof of the finding #2 fix: fire a statusLine payload that
  // mimics what we saw on session 776e1edf (1M-context Opus at 284k tokens,
  // 200k reported window, used_percentage=100 in the raw payload). Assert
  // the snapshot reports the recomputed percentage, not the raw one.
  await withServerAndWs(async (srv, ws) => {
    await ws.waitFor((f) => f.type === 'snapshot');
    const payload = {
      session_id: 'opus1m-integration',
      model: { id: 'claude-opus-4-6[1m]', display_name: 'Opus 4.6 (1M context)' },
      cost: { total_cost_usd: 0.01 },
      context_window: {
        context_window_size: 200000,
        total_input_tokens: 284918,
        total_output_tokens: 0,
        used_percentage: 100,
        current_usage: {},
      },
      _source: 'statusLine',
    };
    await postJson(srv.baseUrl + '/api/status', payload);

    const snap = await getJson(srv.baseUrl + '/api/snapshot');
    const live = snap.liveSessions['opus1m-integration'];
    assert.ok(live);
    assert.strictEqual(live.context_window._resolvedSize, 1_000_000);
    assert.strictEqual(
      live.context_window.used_percentage,
      28,
      'used_percentage must be recomputed against real 1M window',
    );
  });
});

summary();

/**
 * Integration tests for server/broadcaster.js — verify the WebSocket relay
 * fires events for tool, turn-end, and statusLineState changes.
 */
import assert from 'assert';
import { mkdirSync, copyFileSync, readFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { test, summary } from '../helpers/test-harness.js';
import { withTmp } from '../helpers/tmp.js';
import { startTestServer, postJson } from '../helpers/server.js';
import { openTestWs } from '../helpers/ws-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'fixtures');

console.log('broadcaster integration tests:\n');

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
  }, 'srv-ws');
}

test('initial WS frame is a snapshot containing statusLineState', async () => {
  await withServerAndWs(async (srv, ws) => {
    const snap = await ws.waitFor((f) => f.type === 'snapshot', 2000);
    assert.ok(snap.data);
    assert.ok('statusLineState' in snap.data);
  });
});

test('POST /api/hooks broadcasts toolEvent frame', async () => {
  await withServerAndWs(async (srv, ws) => {
    await ws.waitFor((f) => f.type === 'snapshot');
    await postJson(srv.baseUrl + '/api/hooks', {
      tool_name: 'Read',
      session_id: 'ws-test',
      cwd: '/tmp',
    });
    const frame = await ws.waitFor((f) => f.type === 'toolEvent', 2000);
    assert.strictEqual(frame.data.tool, 'Read');
  });
});

test('POST /api/turn-end broadcasts turnEnd frame', async () => {
  await withServerAndWs(async (srv, ws) => {
    await ws.waitFor((f) => f.type === 'snapshot');
    // Need a live session first
    const payload = JSON.parse(readFileSync(join(FIXTURES, 'hooks/status-line.json'), 'utf-8'));
    await postJson(srv.baseUrl + '/api/status', payload);
    await postJson(srv.baseUrl + '/api/turn-end', { session_id: payload.session_id });
    const frame = await ws.waitFor((f) => f.type === 'turnEnd', 2000);
    assert.strictEqual(frame.data.sessionId, payload.session_id);
  });
});

test('POST /api/status with statusLine source broadcasts liveSession frame', async () => {
  await withServerAndWs(async (srv, ws) => {
    await ws.waitFor((f) => f.type === 'snapshot');
    const payload = JSON.parse(readFileSync(join(FIXTURES, 'hooks/status-line.json'), 'utf-8'));
    await postJson(srv.baseUrl + '/api/status', payload);
    const frame = await ws.waitFor((f) => f.type === 'liveSession', 2000);
    assert.ok(frame.data);
  });
});

summary();

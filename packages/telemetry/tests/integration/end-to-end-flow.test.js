/**
 * End-to-end integration test: simulate a full session lifecycle through the
 * server's REST + WebSocket surface and verify state evolution.
 */
import assert from 'assert';
import { mkdirSync, copyFileSync, readFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { test, summary } from '../helpers/test-harness.js';
import { withTmp } from '../helpers/tmp.js';
import { startTestServer, getJson, postJson } from '../helpers/server.js';
import { openTestWs } from '../helpers/ws-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'fixtures');

console.log('end-to-end-flow integration test:\n');

test('full lifecycle: tool → status → turnEnd → tool → compact', async () => {
  await withTmp(async (home) => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    copyFileSync(join(FIXTURES, 'settings/healthy.json'), join(home, '.claude', 'settings.json'));
    const srv = await startTestServer({ tmpHome: home });
    let ws;
    try {
      ws = await openTestWs(srv.wsUrl);
      await ws.waitFor((f) => f.type === 'snapshot');

      const sessionId = 'e2e-test-session';
      const statusPayload = {
        ...JSON.parse(readFileSync(join(FIXTURES, 'hooks/status-line.json'), 'utf-8')),
        session_id: sessionId,
      };

      // Step 1: tool event
      await postJson(srv.baseUrl + '/api/hooks', {
        tool_name: 'Read',
        session_id: sessionId,
        cwd: '/tmp/e2e',
      });
      await ws.waitFor((f) => f.type === 'toolEvent', 2000);

      // Step 2: statusLine post
      await postJson(srv.baseUrl + '/api/status', statusPayload);
      await ws.waitFor((f) => f.type === 'liveSession', 2000);

      // Step 3: turn end
      await postJson(srv.baseUrl + '/api/turn-end', { session_id: sessionId });
      await ws.waitFor((f) => f.type === 'turnEnd', 2000);

      // Step 4: another tool
      await postJson(srv.baseUrl + '/api/hooks', {
        tool_name: 'Bash',
        session_id: sessionId,
        cwd: '/tmp/e2e',
      });

      // Step 5: compact
      await postJson(srv.baseUrl + '/api/compact', { session_id: sessionId, trigger: 'auto' });
      await ws.waitFor((f) => f.type === 'compactEvent', 2000);

      // Final snapshot assertions
      const snap = await getJson(srv.baseUrl + '/api/snapshot');
      const live = snap.liveSessions[sessionId];
      assert.ok(live, 'live session should exist');
      assert.strictEqual(live._turnCount, 1, 'one turn ended');
      assert.strictEqual(live._compactEvents.length, 1, 'one compaction recorded');
      assert.ok(live._toolCount >= 2, 'at least 2 tool events tracked');
      assert.ok(snap.toolEvents.length >= 2, 'global tool event log has 2');
    } finally {
      if (ws) await ws.close();
      await srv.stop();
    }
  }, 'e2e');
});

summary();

/**
 * Integration tests for forced-continuation detection (B1′).
 *
 * Pattern under test: Stop hook fires → tool event arrives without an
 * intervening UserPromptSubmit → telemetry records it as a forced
 * continuation and broadcasts a `forcedContinuation` WebSocket frame.
 *
 * We can't see the Stop hook's {ok, reason} output from any observable
 * surface, so this indirect signal is all the dashboard gets. The signal
 * is agnostic to which Stop hook (Layer 3a, user-configured agent hook,
 * third-party) caused the rejection.
 */
import assert from 'assert';
import { mkdirSync, copyFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { test, summary } from '../helpers/test-harness.js';
import { withTmp } from '../helpers/tmp.js';
import { startTestServer, getJson, postJson } from '../helpers/server.js';
import { openTestWs } from '../helpers/ws-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'fixtures');

console.log('forced-continuation integration tests:\n');

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
  }, 'forced-cont');
}

async function seedSession(srv, sessionId) {
  await postJson(srv.baseUrl + '/api/status', {
    session_id: sessionId,
    model: { id: 'claude-opus-4-6', display_name: 'Opus 4.6' },
    cost: { total_cost_usd: 0.5 },
    context_window: { context_window_size: 200000, total_input_tokens: 5000, used_percentage: 3 },
    workspace: { current_dir: '/tmp/fc' },
    _source: 'statusLine',
  });
  await postJson(srv.baseUrl + '/api/prompt', {
    session_id: sessionId,
    prompt: 'please do a thing',
  });
}

test('Stop → tool event without prompt broadcasts forcedContinuation frame', async () => {
  await withServer(async (srv) => {
    const ws = await openTestWs(srv.wsUrl);
    try {
      await seedSession(srv, 'fc-int-1');
      await ws.waitFor((f) => f.type === 'promptUpdate');

      // Stop fires
      await postJson(srv.baseUrl + '/api/turn-end', { session_id: 'fc-int-1' });
      await ws.waitFor((f) => f.type === 'turnEnd');

      // Tool event arrives with NO intervening UserPromptSubmit
      await postJson(srv.baseUrl + '/api/hooks', {
        tool_name: 'Read',
        session_id: 'fc-int-1',
      });

      const frame = await ws.waitFor((f) => f.type === 'forcedContinuation');
      assert.strictEqual(frame.data.sessionId, 'fc-int-1');
      assert.strictEqual(frame.data.consecutive, 1);
      assert.strictEqual(frame.data.total, 1);
      assert.strictEqual(frame.data.entry.firstTool, 'Read');

      const snap = await getJson(srv.baseUrl + '/api/snapshot');
      const live = snap.liveSessions['fc-int-1'];
      assert.strictEqual(live._forcedContinuations.length, 1);
      assert.strictEqual(live._consecutiveForcedContinuations, 1);
    } finally {
      await ws.close();
    }
  });
});

test('multiple tool events after one Stop count as a single forced continuation', async () => {
  await withServer(async (srv) => {
    const ws = await openTestWs(srv.wsUrl);
    try {
      await seedSession(srv, 'fc-int-2');
      await ws.waitFor((f) => f.type === 'promptUpdate');

      await postJson(srv.baseUrl + '/api/turn-end', { session_id: 'fc-int-2' });
      await ws.waitFor((f) => f.type === 'turnEnd');

      await postJson(srv.baseUrl + '/api/hooks', { tool_name: 'Read', session_id: 'fc-int-2' });
      await postJson(srv.baseUrl + '/api/hooks', { tool_name: 'Bash', session_id: 'fc-int-2' });
      await postJson(srv.baseUrl + '/api/hooks', { tool_name: 'Edit', session_id: 'fc-int-2' });

      // Give WS a beat
      await new Promise((r) => setTimeout(r, 100));

      const snap = await getJson(srv.baseUrl + '/api/snapshot');
      const live = snap.liveSessions['fc-int-2'];
      assert.strictEqual(live._forcedContinuations.length, 1, 'dedupe per Stop');
      assert.strictEqual(live._consecutiveForcedContinuations, 1);
    } finally {
      await ws.close();
    }
  });
});

test('new UserPromptSubmit resets the consecutive counter', async () => {
  await withServer(async (srv) => {
    const ws = await openTestWs(srv.wsUrl);
    try {
      await seedSession(srv, 'fc-int-3');
      await ws.waitFor((f) => f.type === 'promptUpdate');

      await postJson(srv.baseUrl + '/api/turn-end', { session_id: 'fc-int-3' });
      await ws.waitFor((f) => f.type === 'turnEnd');
      await postJson(srv.baseUrl + '/api/hooks', { tool_name: 'Read', session_id: 'fc-int-3' });
      await ws.waitFor((f) => f.type === 'forcedContinuation');

      // User speaks again
      await postJson(srv.baseUrl + '/api/prompt', {
        session_id: 'fc-int-3',
        prompt: 'never mind, stop',
      });
      await ws.waitFor((f) => f.type === 'promptUpdate' && f.data.prompt.includes('never mind'));

      const snap = await getJson(srv.baseUrl + '/api/snapshot');
      const live = snap.liveSessions['fc-int-3'];
      assert.strictEqual(live._consecutiveForcedContinuations, 0);
      // History preserved
      assert.strictEqual(live._forcedContinuations.length, 1);
    } finally {
      await ws.close();
    }
  });
});

summary();

/**
 * Integration tests for config-change + task-completed HTTP → WebSocket flow.
 *
 * The flow under test:
 *   POST /api/config-change → store.recordConfigChange → WebSocket 'configChange' + 'failureEvent'
 *   POST /api/task-completed → store.recordTaskCompleted → WebSocket 'taskCompleted'
 *
 * Critical for oversight: config drift is the top cause of "why did my hooks
 * stop firing" and the only way to notice it is to see the event.
 */
import assert from 'assert';
import { mkdirSync, copyFileSync, existsSync, readFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { test, summary } from '../helpers/test-harness.js';
import { withTmp } from '../helpers/tmp.js';
import { startTestServer, getJson, postJson } from '../helpers/server.js';
import { openTestWs } from '../helpers/ws-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'fixtures');

console.log('config-change + task-completed integration tests:\n');

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
  }, 'cfg-task');
}

test('POST /api/config-change → configChange WebSocket frame + failureEvent row', async () => {
  await withServer(async (srv, home) => {
    const ws = await openTestWs(srv.wsUrl);
    try {
      // Seed a live session so the config change can attach
      await postJson(srv.baseUrl + '/api/status', {
        session_id: 'cfg-sess',
        model: { id: 'claude-opus-4-6', display_name: 'Opus 4.6' },
        cost: { total_cost_usd: 1.0 },
        context_window: { context_window_size: 200000, total_input_tokens: 10000, used_percentage: 5 },
        workspace: { current_dir: '/tmp/cfg' },
        _source: 'statusLine',
      });
      await ws.waitFor((f) => f.type === 'liveSession');

      await postJson(srv.baseUrl + '/api/config-change', {
        session_id: 'cfg-sess',
        config_path: '/home/test/.claude/settings.json',
        changes: { hooks: { modified: ['Stop', 'PreToolUse'] } },
      });

      // Both a configChange frame and a failureEvent frame should land
      const cfg = await ws.waitFor((f) => f.type === 'configChange');
      assert.strictEqual(cfg.data.sessionId, 'cfg-sess');
      assert.strictEqual(cfg.data.event.config_path, '/home/test/.claude/settings.json');

      const failureFrame = await ws.waitFor((f) => f.type === 'failureEvent' && f.data.eventType === 'config_change');
      assert.strictEqual(failureFrame.data.sessionId, 'cfg-sess');
      assert.strictEqual(failureFrame.data.toolName, 'Config');

      // Snapshot should have the event on the live session
      const snap = await getJson(srv.baseUrl + '/api/snapshot');
      assert.strictEqual(snap.liveSessions['cfg-sess']._configChanges.length, 1);

      // And the failure JSONL on disk should contain a config_change row
      const failurePath = join(home, '.claude', 'telemetry-failures.jsonl');
      assert.ok(existsSync(failurePath));
      const content = readFileSync(failurePath, 'utf-8');
      assert.ok(content.includes('"eventType":"config_change"'));
    } finally {
      await ws.close();
    }
  });
});

test('POST /api/task-completed → taskCompleted WebSocket frame with session task list', async () => {
  await withServer(async (srv) => {
    const ws = await openTestWs(srv.wsUrl);
    try {
      await postJson(srv.baseUrl + '/api/status', {
        session_id: 'task-sess',
        model: { id: 'claude-opus-4-6', display_name: 'Opus 4.6' },
        cost: { total_cost_usd: 0.5 },
        context_window: { context_window_size: 200000, total_input_tokens: 5000, used_percentage: 2 },
        workspace: { current_dir: '/tmp/task' },
        _source: 'statusLine',
      });
      await ws.waitFor((f) => f.type === 'liveSession');

      await postJson(srv.baseUrl + '/api/task-completed', {
        session_id: 'task-sess',
        task_id: 'abc-123',
        task_description: 'Refactor the X module',
        status: 'completed',
      });

      const frame = await ws.waitFor((f) => f.type === 'taskCompleted');
      assert.strictEqual(frame.data.sessionId, 'task-sess');
      assert.strictEqual(frame.data.task.task_id, 'abc-123');
      assert.strictEqual(frame.data.task.status, 'completed');

      const snap = await getJson(srv.baseUrl + '/api/snapshot');
      const live = snap.liveSessions['task-sess'];
      assert.strictEqual(live._completedTasks.length, 1);
      assert.strictEqual(live._completedTasks[0].task_description, 'Refactor the X module');
    } finally {
      await ws.close();
    }
  });
});

test('POST /api/hooks with event_type=validation_suggest persists as a non-failure row', async () => {
  await withServer(async (srv, home) => {
    // tool-validator-v2 fires this shape: success=false, event_type='validation_suggest'
    await postJson(srv.baseUrl + '/api/hooks', {
      tool_name: 'Bash',
      session_id: 'suggest-sess',
      event_type: 'validation_suggest',
      success: false,
      error: '[SUGGEST] Use Read instead of cat',
    });

    const failurePath = join(home, '.claude', 'telemetry-failures.jsonl');
    assert.ok(existsSync(failurePath));
    const content = readFileSync(failurePath, 'utf-8');
    assert.ok(content.includes('"eventType":"validation_suggest"'));
    assert.ok(content.includes('[SUGGEST]'));
  });
});

summary();

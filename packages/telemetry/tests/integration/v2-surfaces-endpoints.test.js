/**
 * Integration tests for the v2 surface endpoints + oversight WS push:
 *   GET /api/sessions    — per-session detail (Sessions surface, plan 3.2)
 *   GET /api/subagents   — cross-session agent aggregation (Subagents, plan 3.3)
 *   WS  oversightEvent   — chokidar push for oversight-events.jsonl appends
 *
 * Spawns the real server with HOME=<tmp> and seeds transcripts on disk.
 */
import assert from 'assert';
import { mkdirSync, writeFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { test, summary } from '../helpers/test-harness.js';
import { withTmp } from '../helpers/tmp.js';
import { startTestServer, getJson } from '../helpers/server.js';
import { openTestWs } from '../helpers/ws-client.js';

console.log('v2-surfaces endpoints integration tests:\n');

function userLine(ts, sessionId, extra = {}) {
  return JSON.stringify({
    type: 'user',
    timestamp: ts,
    sessionId,
    cwd: '/work/proj-x',
    message: { role: 'user', content: 'go' },
    ...extra,
  });
}

function assistantLine(ts, sessionId, model, input) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    sessionId,
    cwd: '/work/proj-x',
    message: {
      role: 'assistant',
      model,
      usage: { input_tokens: input, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      content: [{ type: 'tool_use', id: 'tu_0', name: 'Read', input: {} }, { type: 'text', text: 'ok' }],
    },
  });
}

function seedHome(tmp) {
  mkdirSync(join(tmp, '.claude'), { recursive: true });
  writeFileSync(join(tmp, '.claude', 'settings.json'), JSON.stringify({}));
}

test('GET /api/sessions + /api/subagents serve seeded transcripts with type join', async () => {
  await withTmp(async (tmp) => {
    seedHome(tmp);
    const projDir = join(tmp, '.claude', 'projects', 'proj-x');
    mkdirSync(projDir, { recursive: true });

    // Parent session with an Agent-dispatch result for agent 'ag1'
    writeFileSync(join(projDir, 'sess-1.jsonl'), [
      userLine('2026-06-10T10:00:00Z', 'sess-1'),
      assistantLine('2026-06-10T10:01:00Z', 'sess-1', 'claude-opus-4-7', 1000),
      userLine('2026-06-10T10:05:00Z', 'sess-1', {
        toolUseResult: {
          agentId: 'ag1', agentType: 'Explore', status: 'completed',
          prompt: 'scan the repo', totalDurationMs: 4000, totalToolUseCount: 5,
        },
      }),
    ].join('\n') + '\n');

    // The agent's own transcript, two levels deep
    const subDir = join(projDir, 'sess-1', 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, 'agent-ag1.jsonl'), [
      userLine('2026-06-10T10:01:10Z', 'sess-1'),
      assistantLine('2026-06-10T10:02:00Z', 'sess-1', 'claude-haiku-4-5', 500),
    ].join('\n') + '\n');

    const server = await startTestServer({ tmpHome: tmp });
    try {
      await new Promise((r) => setTimeout(r, 500)); // boot-time loadAll

      const sess = await getJson(`${server.baseUrl}/api/sessions`);
      assert.strictEqual(sess.total, 1, 'agent transcript not counted as a session');
      assert.strictEqual(sess.sessions[0].sessionId, 'sess-1');
      assert.strictEqual(sess.sessions[0].projectDir, 'proj-x');
      assert.strictEqual(sess.sessions[0].primaryModel, 'claude-opus-4-7');
      assert.strictEqual(sess.sessions[0].messageCount, 3);

      const sub = await getJson(`${server.baseUrl}/api/subagents`);
      assert.strictEqual(sub.totalAgents, 1);
      const ag = sub.agents[0];
      assert.strictEqual(ag.agentId, 'ag1');
      assert.strictEqual(ag.agentType, 'Explore', 'type joined from parent toolUseResult');
      assert.strictEqual(ag.status, 'completed');
      assert.strictEqual(ag.parentSessionId, 'sess-1');
      assert.strictEqual(ag.primaryModel, 'claude-haiku-4-5');
      assert.strictEqual(sub.byType.length, 1);
      assert.strictEqual(sub.byType[0].agentType, 'Explore');
      assert.strictEqual(sub.byType[0].runs, 1);
    } finally {
      await server.stop();
    }
  }, 'v2-endpoints');
});

test('GET /api/ccd-sessions maps transcript ids to Desktop titles (empty without APPDATA)', async () => {
  await withTmp(async (tmp) => {
    seedHome(tmp);
    // Seed a fake %APPDATA%/Claude/claude-code-sessions tree
    const appdata = join(tmp, 'appdata');
    const sessDir = join(appdata, 'Claude', 'claude-code-sessions', 'org-1', 'proj-1');
    mkdirSync(sessDir, { recursive: true });
    writeFileSync(join(sessDir, 'local_abc.json'), JSON.stringify({
      sessionId: 'local_abc',
      cliSessionId: 'sess-1',
      title: 'My English Title',
      isArchived: false,
      prNumber: 42,
      prState: 'MERGED',
    }));
    writeFileSync(join(sessDir, 'local_broken.json'), '{not json');

    const server = await startTestServer({ tmpHome: tmp, extraEnv: { APPDATA: appdata } });
    try {
      const res = await getJson(`${server.baseUrl}/api/ccd-sessions`);
      assert.strictEqual(res.byCliId['sess-1'].title, 'My English Title');
      assert.strictEqual(res.byCliId['sess-1'].prState, 'MERGED');
      assert.strictEqual(Object.keys(res.byCliId).length, 1, 'corrupt file skipped');
    } finally {
      await server.stop();
    }
  }, 'v2-ccd-titles');
});

test('double-wrapped event_type lines are normalized, not served as objects', async () => {
  await withTmp(async (tmp) => {
    seedHome(tmp);
    const eventsPath = join(tmp, '.claude', 'oversight-events.jsonl');
    // The malformed shape scribe-db.js wrote 2026-06-11 (whole event object
    // passed as the eventType arg) — crashed v2 Oversight with React #31.
    writeFileSync(eventsPath, [
      JSON.stringify({
        timestamp: new Date().toISOString(),
        event_type: { event_type: 'scribe_db_write_failed', data: { bucket: 'cleanup', row_id: 'r1', error: 'psql missing' } },
        data: {},
      }),
      JSON.stringify({ timestamp: new Date().toISOString(), event_type: 'instructions_loaded', data: {} }),
    ].join('\n') + '\n');

    const server = await startTestServer({ tmpHome: tmp });
    try {
      const res = await getJson(`${server.baseUrl}/api/oversight/events?days=7`);
      assert.ok(res.eventsByType['scribe_db_write_failed'], 'inner event_type unwrapped');
      assert.ok(res.eventsByType['instructions_loaded'], 'well-formed line untouched');
      for (const e of res.recent) {
        assert.strictEqual(typeof e.event_type, 'string', 'every served event_type is a string');
      }
      const unwrapped = res.recent.find((e) => e.event_type === 'scribe_db_write_failed');
      assert.strictEqual(unwrapped.data.bucket, 'cleanup', 'inner data unwrapped alongside type');
    } finally {
      await server.stop();
    }
  }, 'v2-oversight-normalize');
});

test('WS pushes oversightEvent frames when oversight-events.jsonl grows', async () => {
  await withTmp(async (tmp) => {
    seedHome(tmp);
    const eventsPath = join(tmp, '.claude', 'oversight-events.jsonl');
    // Pre-existing content — the watcher must start at EOF and not re-emit it
    writeFileSync(eventsPath, JSON.stringify({
      timestamp: '2026-06-10T09:00:00Z', event_type: 'instructions_loaded', data: {},
    }) + '\n');

    const server = await startTestServer({ tmpHome: tmp });
    try {
      await new Promise((r) => setTimeout(r, 500)); // let watchers attach
      const wsClient = await openTestWs(`ws://127.0.0.1:${server.port}/ws`);

      appendFileSync(eventsPath, JSON.stringify({
        timestamp: '2026-06-10T12:00:00Z',
        event_type: 'subagent_orphan_alert',
        data: { session_id: 'sess-ws-test' },
      }) + '\n');

      // chokidar poll (3s) + awaitWriteFinish stability (1s) → allow up to 10s
      const frame = await wsClient.waitFor(
        (f) => f.type === 'oversightEvent'
          && f.data?.events?.some((e) => e.event_type === 'subagent_orphan_alert'),
        10_000
      );
      assert.strictEqual(frame.data.events.length, 1, 'only the appended event, not the pre-existing line');
      assert.strictEqual(frame.data.events[0].data.session_id, 'sess-ws-test');

      await wsClient.close();
    } finally {
      await server.stop();
    }
  }, 'v2-oversight-ws');
});

summary();

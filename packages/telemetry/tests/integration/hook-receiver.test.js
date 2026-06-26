/**
 * Integration tests for server/hook-receiver.js endpoints.
 *
 * Spawns a real server in a tmp HOME, fires real HTTP POSTs, asserts the
 * snapshot reflects the changes. Tests the _source discrimination contract:
 * statusLine-sourced posts update lastStatusPostAt, toolPiggyback ones don't.
 */
import assert from 'assert';
import { mkdirSync, copyFileSync, readFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { test, summary } from '../helpers/test-harness.js';
import { withTmp } from '../helpers/tmp.js';
import { startTestServer, getJson, postJson } from '../helpers/server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'fixtures');

console.log('hook-receiver integration tests:\n');

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
  }, 'srv');
}

test('POST /api/hooks records a tool event in snapshot', async () => {
  await withServer(async (srv) => {
    const event = JSON.parse(readFileSync(join(FIXTURES, 'hooks/post-tool-use.json'), 'utf-8'));
    await postJson(srv.baseUrl + '/api/hooks', event);
    const snap = await getJson(srv.baseUrl + '/api/snapshot');
    assert.ok(snap.toolEvents.length >= 1);
    assert.strictEqual(snap.toolEvents[0].tool, 'Read');
  });
});

test('POST /api/hooks with success=false persists to failure store', async () => {
  await withServer(async (srv, home) => {
    await postJson(srv.baseUrl + '/api/hooks', {
      tool_name: 'Bash',
      session_id: 'fail-test',
      event_type: 'post_tool_use_failure',
      success: false,
      error: 'simulated failure',
    });
    // Failure store writes to ~/.claude/telemetry-failures.jsonl in tmp HOME
    const failurePath = join(home, '.claude', 'telemetry-failures.jsonl');
    const content = readFileSync(failurePath, 'utf-8');
    assert.ok(content.includes('simulated failure'));
  });
});

test('POST /api/status with _source: statusLine updates lastStatusPostAt', async () => {
  await withServer(async (srv) => {
    const before = await getJson(srv.baseUrl + '/api/snapshot');
    const beforeTime = before.statusLineState.lastStatusPostAt || 0;

    await new Promise((r) => setTimeout(r, 50));
    const payload = JSON.parse(readFileSync(join(FIXTURES, 'hooks/status-line.json'), 'utf-8'));
    await postJson(srv.baseUrl + '/api/status', payload);

    const after = await getJson(srv.baseUrl + '/api/snapshot');
    assert.ok(
      after.statusLineState.lastStatusPostAt > beforeTime,
      'lastStatusPostAt must advance for _source=statusLine'
    );
  });
});

test('POST /api/status with _source: toolPiggyback does NOT update lastStatusPostAt', async () => {
  await withServer(async (srv) => {
    // First fire a real statusLine post to anchor the timestamp
    const realPayload = JSON.parse(readFileSync(join(FIXTURES, 'hooks/status-line.json'), 'utf-8'));
    await postJson(srv.baseUrl + '/api/status', realPayload);
    const anchor = await getJson(srv.baseUrl + '/api/snapshot');
    const anchorTime = anchor.statusLineState.lastStatusPostAt;
    assert.ok(anchorTime > 0, 'real statusLine should have set timestamp');

    await new Promise((r) => setTimeout(r, 50));

    // Now fire a piggyback post — must NOT update the timestamp
    const piggyback = JSON.parse(readFileSync(join(FIXTURES, 'hooks/status-line-piggyback.json'), 'utf-8'));
    await postJson(srv.baseUrl + '/api/status', piggyback);

    const after = await getJson(srv.baseUrl + '/api/snapshot');
    assert.strictEqual(
      after.statusLineState.lastStatusPostAt,
      anchorTime,
      'lastStatusPostAt must NOT advance for _source=toolPiggyback'
    );
  });
});

test('POST /api/turn-end increments live session turn count', async () => {
  await withServer(async (srv) => {
    // Create a live session via statusLine post
    const payload = JSON.parse(readFileSync(join(FIXTURES, 'hooks/status-line.json'), 'utf-8'));
    await postJson(srv.baseUrl + '/api/status', payload);

    await postJson(srv.baseUrl + '/api/turn-end', { session_id: payload.session_id });
    await postJson(srv.baseUrl + '/api/turn-end', { session_id: payload.session_id });

    const snap = await getJson(srv.baseUrl + '/api/snapshot');
    const live = snap.liveSessions[payload.session_id];
    assert.ok(live);
    assert.strictEqual(live._turnCount, 2);
  });
});

test('POST /api/compact appends to compact events', async () => {
  await withServer(async (srv) => {
    const payload = JSON.parse(readFileSync(join(FIXTURES, 'hooks/status-line.json'), 'utf-8'));
    await postJson(srv.baseUrl + '/api/status', payload);
    await postJson(srv.baseUrl + '/api/compact', { session_id: payload.session_id, trigger: 'auto' });

    const snap = await getJson(srv.baseUrl + '/api/snapshot');
    const live = snap.liveSessions[payload.session_id];
    assert.ok(live._compactEvents);
    assert.strictEqual(live._compactEvents.length, 1);
  });
});

test('GET /api/snapshot includes statusLineState field', async () => {
  await withServer(async (srv) => {
    const snap = await getJson(srv.baseUrl + '/api/snapshot');
    assert.ok('statusLineState' in snap);
    assert.ok('class' in snap.statusLineState);
  });
});

summary();

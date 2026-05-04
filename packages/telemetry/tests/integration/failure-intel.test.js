/**
 * Integration tests for Phase D:
 * - D3: prompt linkage — failure happens while a prompt is in flight
 * - D4: /api/failures/top-cost returns ranked records
 * - D5: /api/hook-health returns a shape the UI can consume
 */
import assert from 'assert';
import { mkdirSync, copyFileSync, writeFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { test, summary } from '../helpers/test-harness.js';
import { withTmp } from '../helpers/tmp.js';
import { startTestServer, getJson, postJson } from '../helpers/server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'fixtures');

console.log('failure-intel integration tests:\n');

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
  }, 'failure-intel');
}

test('D3: failure POSTed while prompt is active carries promptId + promptSnippet into JSONL', async () => {
  await withServer(async (srv, home) => {
    const sid = 'd3-sess';
    await postJson(srv.baseUrl + '/api/status', {
      session_id: sid,
      model: { id: 'claude-opus-4-6', display_name: 'Opus 4.6' },
      cost: { total_cost_usd: 0.5 },
      context_window: { context_window_size: 200000, total_input_tokens: 5000, used_percentage: 3 },
      workspace: { current_dir: '/tmp/d3' },
      _source: 'statusLine',
    });
    await postJson(srv.baseUrl + '/api/prompt', {
      session_id: sid,
      prompt: 'please read the config file at /tmp/nonexistent',
    });
    await postJson(srv.baseUrl + '/api/hooks', {
      tool_name: 'Read',
      session_id: sid,
      event_type: 'post_tool_use_failure',
      success: false,
      error: 'ENOENT: no such file',
      tool_input: { file_path: '/tmp/nonexistent' },
    });
    await new Promise((r) => setTimeout(r, 100));

    const failures = await getJson(srv.baseUrl + '/api/failures?session=' + sid);
    assert.ok(failures.length > 0);
    const f = failures[0];
    assert.ok(f.promptId && f.promptId.startsWith(sid + '::'), `expected promptId to start with session id, got ${f.promptId}`);
    assert.ok(f.promptSnippet && f.promptSnippet.includes('please read the config'));
    assert.strictEqual(f.errorClass, 'not_found');
  });
});

test('D4: /api/failures/top-cost returns ranked records descending', async () => {
  await withServer(async (srv) => {
    const sid = 'd4-sess';
    await postJson(srv.baseUrl + '/api/status', {
      session_id: sid,
      model: { id: 'claude-opus-4-6', display_name: 'Opus 4.6' },
      cost: { total_cost_usd: 0.5 },
      context_window: { context_window_size: 200000, total_input_tokens: 5000, used_percentage: 3 },
      workspace: { current_dir: '/tmp/d4' },
      _source: 'statusLine',
    });
    // Post three failures with different estimated costs
    for (const cost of [0.02, 0.50, 0.05]) {
      await postJson(srv.baseUrl + '/api/hooks', {
        tool_name: 'Read',
        session_id: sid,
        event_type: 'post_tool_use_failure',
        success: false,
        error: `cost probe ${cost}`,
        estimated_cost: cost,
      });
    }
    await new Promise((r) => setTimeout(r, 80));

    const top = await getJson(srv.baseUrl + '/api/failures/top-cost?n=2');
    assert.strictEqual(top.length, 2);
    assert.strictEqual(top[0].estimatedCost, 0.50);
    assert.strictEqual(top[1].estimatedCost, 0.05);
  });
});

test('D5: /api/hook-health returns a healthy shape when log is missing', async () => {
  await withServer(async (srv) => {
    // In the tmp HOME the hook-debug.log path under PROJECT_ROOT is absent.
    // The endpoint should return exists:false without throwing.
    const h = await getJson(srv.baseUrl + '/api/hook-health');
    assert.ok(typeof h.exists === 'boolean');
    assert.ok(typeof h.healthy === 'boolean');
    assert.ok(typeof h.errorCount === 'number');
    assert.ok(Array.isArray(h.recentErrors));
  });
});

summary();

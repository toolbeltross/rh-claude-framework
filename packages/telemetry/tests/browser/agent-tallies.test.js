/**
 * Browser test: Phase C1/C2/C3 badges render on the Agents tab.
 */
import assert from 'assert';
import { test, summary, afterAll } from '../helpers/test-harness.js';
import { withDashboard, closeBrowser } from './harness.js';
import { postJson } from '../helpers/server.js';

afterAll(closeBrowser);

console.log('agent-tallies browser tests:\n');

const SESSION_ID = 'browser-tallies';

async function seedLiveSession(baseUrl) {
  await postJson(`${baseUrl}/api/status`, {
    session_id: SESSION_ID,
    model: { id: 'claude-opus-4-6', display_name: 'Opus 4.6' },
    cost: { total_cost_usd: 1.0 },
    context_window: {
      context_window_size: 200000,
      total_input_tokens: 50000,
      used_percentage: 25,
      current_usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 49000, cache_creation_input_tokens: 0 },
    },
    workspace: { current_dir: '/tmp/tallies' },
    _source: 'statusLine',
  });
}

async function startAgent(baseUrl) {
  await postJson(`${baseUrl}/api/subagent`, {
    session_id: SESSION_ID,
    action: 'start',
    agent_id: 'browser-agent-1',
    agent_type: 'Explore',
  });
}

async function clickSubTab(page, name) {
  const btn = page.locator(`button:has-text("${name}")`).first();
  await btn.click();
  await page.waitForTimeout(150);
}

test('C1: active agent with failures shows red "N fails" badge', async () => {
  await withDashboard(async ({ page, baseUrl }) => {
    await seedLiveSession(baseUrl);
    await page.waitForTimeout(300);
    await startAgent(baseUrl);
    await page.waitForTimeout(200);
    await postJson(`${baseUrl}/api/hooks`, {
      tool_name: 'Read',
      session_id: SESSION_ID,
      agent_id: 'browser-agent-1',
      event_type: 'post_tool_use_failure',
      success: false,
      error: 'ENOENT',
    });
    await postJson(`${baseUrl}/api/hooks`, {
      tool_name: 'Read',
      session_id: SESSION_ID,
      agent_id: 'browser-agent-1',
      event_type: 'post_tool_use_failure',
      success: false,
      error: 'EACCES',
    });
    await page.waitForTimeout(400);
    await clickSubTab(page, 'Agents');

    const badge = page.locator('[data-testid="agent-failure-count"]').first();
    await badge.waitFor({ timeout: 2000 });
    const text = await badge.textContent();
    assert.ok(text.includes('2'), `expected "2 fails", got '${text}'`);
    assert.ok(text.includes('fails'));
  });
});

test('C3: active agent with validation_block events shows amber "N blocked" badge', async () => {
  await withDashboard(async ({ page, baseUrl }) => {
    await seedLiveSession(baseUrl);
    await page.waitForTimeout(300);
    await startAgent(baseUrl);
    await page.waitForTimeout(200);
    await postJson(`${baseUrl}/api/hooks`, {
      tool_name: 'Bash',
      session_id: SESSION_ID,
      agent_id: 'browser-agent-1',
      event_type: 'validation_block',
      success: false,
      error: '[BLOCK] cat not allowed',
    });
    await page.waitForTimeout(400);
    await clickSubTab(page, 'Agents');

    const badge = page.locator('[data-testid="agent-validation-block-count"]').first();
    await badge.waitFor({ timeout: 2000 });
    const text = await badge.textContent();
    assert.ok(text.includes('1'));
    assert.ok(text.includes('blocked'));
  });
});

test('C2: completed agent with transcriptStatus:missing shows amber "transcript lost" badge', async () => {
  await withDashboard(async ({ page, baseUrl }) => {
    await seedLiveSession(baseUrl);
    await page.waitForTimeout(300);
    await startAgent(baseUrl);
    await page.waitForTimeout(200);
    await postJson(`${baseUrl}/api/subagent`, {
      session_id: SESSION_ID,
      action: 'stop',
      agent_id: 'browser-agent-1',
      agent_type: 'Explore',
    });
    await page.waitForTimeout(400);
    await clickSubTab(page, 'Agents');

    // V2: completed agents are in the unified table, no expand needed
    const chip = page.locator('[data-testid="completed-agent-transcript-lost"]').first();
    await chip.waitFor({ timeout: 2000 });
    const text = await chip.textContent();
    assert.ok(text.includes('transcript lost'), `expected 'transcript lost', got '${text}'`);
  });
});

test('C2: header health strip shows transcript-lost count', async () => {
  await withDashboard(async ({ page, baseUrl }) => {
    await seedLiveSession(baseUrl);
    await page.waitForTimeout(300);
    await startAgent(baseUrl);
    await page.waitForTimeout(200);
    await postJson(`${baseUrl}/api/subagent`, {
      session_id: SESSION_ID,
      action: 'stop',
      agent_id: 'browser-agent-1',
      agent_type: 'Explore',
    });
    await page.waitForTimeout(400);
    await clickSubTab(page, 'Agents');

    // V2: transcript-lost count shown in header stats strip
    const header = page.locator('[data-testid="agents-header-strip"]');
    await header.waitFor({ timeout: 2000 });
    const text = await header.textContent();
    assert.ok(text.toLowerCase().includes('lost tx'), `expected 'lost tx' in header, got '${text}'`);
  });
});

summary();

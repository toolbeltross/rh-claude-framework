/**
 * Browser test: Agents tab v2 — unified table with header stats strip,
 * prompt/result columns, and click-to-expand detail panels.
 */
import assert from 'assert';
import { test, summary, afterAll } from '../helpers/test-harness.js';
import { withDashboard, closeBrowser } from './harness.js';
import { postJson } from '../helpers/server.js';

afterAll(closeBrowser);

console.log('agents-tab-v2 browser tests:\n');

const SESSION_ID = 'browser-v2-test';

async function seedSession(baseUrl) {
  await postJson(`${baseUrl}/api/status`, {
    session_id: SESSION_ID,
    model: { id: 'claude-opus-4-6', display_name: 'Opus 4.6' },
    cost: { total_cost_usd: 5.0 },
    context_window: {
      context_window_size: 200000, total_input_tokens: 80000, used_percentage: 40,
      current_usage: { input_tokens: 2000, output_tokens: 500, cache_read_input_tokens: 78000, cache_creation_input_tokens: 0 },
    },
    workspace: { current_dir: '/tmp/v2-dash' },
    version: '2.1.117',
    _source: 'statusLine',
  });
}

async function addActiveAgent(baseUrl, id, type, prompt) {
  await postJson(`${baseUrl}/api/subagent`, {
    session_id: SESSION_ID, action: 'start',
    agent_id: id, agent_type: type, prompt: prompt || '',
  });
}

async function completeAgent(baseUrl, id, type, cost, lastMessage, prompt) {
  await postJson(`${baseUrl}/api/subagent`, {
    session_id: SESSION_ID, action: 'stop',
    agent_id: id, agent_type: type,
    last_assistant_message: lastMessage || '',
    permission_mode: 'default',
    prompt: prompt || '',
    _transcriptMetrics: {
      status: 'ok',
      model: { id: 'claude-haiku-4-5-20251001', display_name: 'Haiku' },
      cost: { total_cost_usd: cost },
      tokens: { input: 3000, output: 1000, cacheRead: 2000, cacheWrite: 500, total: 4000 },
      turns: 4,
    },
  });
}

async function clickSubTab(page, name) {
  const btn = page.locator(`button:has-text("${name}")`).first();
  await btn.click();
  await page.waitForTimeout(150);
}

test('V2: header stats strip renders with agent counts', async () => {
  await withDashboard(async ({ page, baseUrl }) => {
    await seedSession(baseUrl);
    await page.waitForTimeout(400);
    await addActiveAgent(baseUrl, 'active-1', 'Explore', 'Find test files');
    await page.waitForTimeout(300);
    await clickSubTab(page, 'Agents');

    const header = page.locator('[data-testid="agents-header-strip"]');
    await header.waitFor({ timeout: 5000 });
    const headerText = await header.textContent();
    assert.ok(headerText.includes('Agents'), 'Header should contain "Agents" title');
    assert.ok(headerText.includes('active'), 'Header should show active label');
  });
});

test('V2: active agent row shows prompt text', async () => {
  await withDashboard(async ({ page, baseUrl }) => {
    await seedSession(baseUrl);
    await page.waitForTimeout(400);
    await addActiveAgent(baseUrl, 'active-2', 'Plan', 'Design the new architecture');
    await page.waitForTimeout(300);
    await clickSubTab(page, 'Agents');

    const table = page.locator('table');
    await table.waitFor({ timeout: 5000 });
    const bodyText = await table.textContent();
    assert.ok(bodyText.includes('Design the new architecture'), 'Active agent row should show prompt text');
  });
});

test('V2: completed agent row shows prompt and result', async () => {
  await withDashboard(async ({ page, baseUrl }) => {
    await seedSession(baseUrl);
    await page.waitForTimeout(400);
    await addActiveAgent(baseUrl, 'done-2', 'Explore', 'Read package.json version');
    await page.waitForTimeout(200);
    await completeAgent(baseUrl, 'done-2', 'Explore', 0.14, 'version: 1.0.0', 'Read package.json version');
    await page.waitForTimeout(300);
    await clickSubTab(page, 'Agents');

    const table = page.locator('table');
    await table.waitFor({ timeout: 5000 });
    const bodyText = await table.textContent();
    assert.ok(bodyText.includes('Read package.json version'), 'Should show prompt');
    assert.ok(bodyText.includes('version: 1.0.0'), 'Should show result');
  });
});

test('V2: click row expands detail panel with Prompt/Result labels', async () => {
  await withDashboard(async ({ page, baseUrl }) => {
    await seedSession(baseUrl);
    await page.waitForTimeout(400);
    await addActiveAgent(baseUrl, 'done-3', 'general-purpose', 'Review safety');
    await page.waitForTimeout(200);
    await completeAgent(baseUrl, 'done-3', 'general-purpose', 1.04, 'Not safe', 'Review safety');
    await page.waitForTimeout(300);
    await clickSubTab(page, 'Agents');

    const table = page.locator('table');
    await table.waitFor({ timeout: 5000 });

    const row = table.locator('tr').filter({ hasText: 'general' }).first();
    await row.click();
    await page.waitForTimeout(300);

    const tableText = await table.textContent();
    assert.ok(tableText.includes('Prompt'), 'Detail panel should have Prompt label');
    assert.ok(tableText.includes('Result'), 'Detail panel should have Result label');
  });
});

test('V2: version badge shows in header', async () => {
  await withDashboard(async ({ page, baseUrl }) => {
    await seedSession(baseUrl);
    await page.waitForTimeout(400);
    await addActiveAgent(baseUrl, 'v-1', 'Explore', 'test');
    await page.waitForTimeout(300);
    await clickSubTab(page, 'Agents');

    const header = page.locator('[data-testid="agents-header-strip"]');
    await header.waitFor({ timeout: 5000 });
    const headerText = await header.textContent();
    assert.ok(headerText.includes('2.1.117'), 'Header should show version badge');
  });
});

summary();

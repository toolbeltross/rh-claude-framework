/**
 * Browser test: config-change + task-completed + validation-suggest render
 * correctly on the Events & Failures tab and Details tab.
 */
import assert from 'assert';
import { test, summary, afterAll } from '../helpers/test-harness.js';
import { withDashboard, closeBrowser } from './harness.js';
import { postJson } from '../helpers/server.js';

afterAll(closeBrowser);

console.log('config-task-events browser tests:\n');

const SESSION_ID = 'browser-cfg-task';

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
    workspace: { current_dir: '/tmp/cfg-task' },
    _source: 'statusLine',
  });
}

async function clickSubTab(page, name) {
  const btn = page.locator(`button:has-text("${name}")`).first();
  await btn.click();
  await page.waitForTimeout(150);
}

test('config_change → Events & Failures tab shows cyan "config change" label', async () => {
  await withDashboard(async ({ page, baseUrl }) => {
    await seedLiveSession(baseUrl);
    await page.waitForTimeout(300);
    await postJson(`${baseUrl}/api/config-change`, {
      session_id: SESSION_ID,
      config_path: '/home/test/.claude/settings.json',
      changes: { hooks: 'modified' },
    });
    await page.waitForTimeout(400);
    await clickSubTab(page, 'Failures');
    const label = page.locator('text=config change').first();
    await label.waitFor({ timeout: 2000 });
    const count = await page.locator('text=config change').count();
    assert.ok(count > 0, 'config change label should render on Events & Failures tab');
  });
});

test('validation_suggest → Events & Failures tab shows green "tool suggestion" label', async () => {
  await withDashboard(async ({ page, baseUrl }) => {
    await seedLiveSession(baseUrl);
    await page.waitForTimeout(300);
    await postJson(`${baseUrl}/api/hooks`, {
      tool_name: 'Bash',
      session_id: SESSION_ID,
      event_type: 'validation_suggest',
      success: false,
      error: '[SUGGEST] Use Read instead of cat',
    });
    await page.waitForTimeout(400);
    await clickSubTab(page, 'Failures');
    const label = page.locator('text=tool suggestion').first();
    await label.waitFor({ timeout: 2000 });
    const count = await page.locator('text=tool suggestion').count();
    assert.ok(count > 0, 'tool suggestion label should render');
  });
});

test('task_completed → Details tab shows task in TaskCompletions panel', async () => {
  await withDashboard(async ({ page, baseUrl }) => {
    await seedLiveSession(baseUrl);
    await page.waitForTimeout(300);
    await postJson(`${baseUrl}/api/task-completed`, {
      session_id: SESSION_ID,
      task_id: 'task-xyz',
      task_description: 'Refactor the X module',
      status: 'completed',
    });
    await page.waitForTimeout(400);
    await clickSubTab(page, 'Details');
    const label = page.locator('text=Refactor the X module').first();
    await label.waitFor({ timeout: 2000 });
    const count = await page.locator('text=Refactor the X module').count();
    assert.ok(count > 0, 'task description should render in TaskCompletions panel');
  });
});

summary();

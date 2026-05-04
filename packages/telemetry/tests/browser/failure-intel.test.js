/**
 * Browser test: Phase D UI surfaces on the Events & Failures tab:
 * - D1 error-class breakdown chips
 * - D2 retry badge
 * - D4 top-cost panel
 * - D5 hook-health chip
 */
import assert from 'assert';
import { test, summary, afterAll } from '../helpers/test-harness.js';
import { withDashboard, closeBrowser } from './harness.js';
import { postJson } from '../helpers/server.js';

afterAll(closeBrowser);

console.log('failure-intel browser tests:\n');

const SESSION_ID = 'browser-d';

async function seed(baseUrl) {
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
    workspace: { current_dir: '/tmp/d' },
    _source: 'statusLine',
  });
}

async function clickSubTab(page, name) {
  const btn = page.locator(`button:has-text("${name}")`).first();
  await btn.click();
  await page.waitForTimeout(150);
}

test('D1: error-class breakdown chips render on Events & Failures tab', async () => {
  await withDashboard(async ({ page, baseUrl }) => {
    await seed(baseUrl);
    await page.waitForTimeout(300);
    await postJson(`${baseUrl}/api/hooks`, {
      tool_name: 'Read',
      session_id: SESSION_ID,
      event_type: 'post_tool_use_failure',
      success: false,
      error: 'ENOENT: no such file',
    });
    await postJson(`${baseUrl}/api/hooks`, {
      tool_name: 'Bash',
      session_id: SESSION_ID,
      event_type: 'post_tool_use_failure',
      success: false,
      error: 'EACCES: permission denied',
    });
    await page.waitForTimeout(400);
    await clickSubTab(page, 'Failures');

    const breakdown = page.locator('[data-testid="error-class-breakdown"]');
    await breakdown.waitFor({ timeout: 2000 });
    const text = await breakdown.textContent();
    assert.ok(text.includes('not_found'), `expected 'not_found' class in breakdown, got '${text}'`);
    assert.ok(text.includes('permission'), `expected 'permission' class, got '${text}'`);
  });
});

test('D2: two identical tool failures → second gets a retry badge', async () => {
  await withDashboard(async ({ page, baseUrl }) => {
    await seed(baseUrl);
    await page.waitForTimeout(300);
    const payload = {
      tool_name: 'Read',
      session_id: SESSION_ID,
      event_type: 'post_tool_use_failure',
      success: false,
      error: 'ENOENT',
      tool_input: { file_path: '/tmp/never' },
    };
    await postJson(`${baseUrl}/api/hooks`, payload);
    await postJson(`${baseUrl}/api/hooks`, payload);
    await page.waitForTimeout(400);
    await clickSubTab(page, 'Failures');

    const badge = page.locator('[data-testid="failure-retry-badge"]').first();
    await badge.waitFor({ timeout: 2000 });
    const text = await badge.textContent();
    assert.ok(text.includes('retry'), `expected 'retry', got '${text}'`);
    assert.ok(text.includes('1'), `expected retry #1, got '${text}'`);
  });
});

test('D5: hook-health chip renders on Events & Failures tab', async () => {
  await withDashboard(async ({ page, baseUrl }) => {
    await seed(baseUrl);
    await page.waitForTimeout(300);
    // Need one failure so the failures tab is selectable/not empty
    await postJson(`${baseUrl}/api/hooks`, {
      tool_name: 'Read',
      session_id: SESSION_ID,
      event_type: 'post_tool_use_failure',
      success: false,
      error: 'x',
    });
    await page.waitForTimeout(1200); // useEffect fires fetch on mount
    await clickSubTab(page, 'Failures');

    const chip = page.locator('[data-testid="hook-health-chip"]').first();
    await chip.waitFor({ timeout: 2500 });
    const text = await chip.textContent();
    assert.ok(text.toLowerCase().includes('hook'), `expected chip text to mention 'hooks', got '${text}'`);
  });
});

summary();

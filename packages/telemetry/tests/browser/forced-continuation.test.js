/**
 * Browser test: forced-continuation badge + possible-loop banner render on
 * the Session tab when Stop→tool events fire without an intervening
 * UserPromptSubmit.
 */
import assert from 'assert';
import { test, summary, afterAll } from '../helpers/test-harness.js';
import { withDashboard, closeBrowser } from './harness.js';
import { postJson } from '../helpers/server.js';

afterAll(closeBrowser);

console.log('forced-continuation browser tests:\n');

const SESSION_ID = 'browser-fc';

async function seedLiveSession(baseUrl, sessionId = SESSION_ID) {
  await postJson(`${baseUrl}/api/status`, {
    session_id: sessionId,
    model: { id: 'claude-opus-4-6', display_name: 'Opus 4.6' },
    cost: { total_cost_usd: 1.0 },
    context_window: {
      context_window_size: 200000,
      total_input_tokens: 50000,
      used_percentage: 25,
      current_usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 49000, cache_creation_input_tokens: 0 },
    },
    workspace: { current_dir: '/tmp/fc-browser' },
    _source: 'statusLine',
  });
  await postJson(`${baseUrl}/api/prompt`, {
    session_id: sessionId,
    prompt: 'do the thing',
  });
}

async function fireForcedContinuation(baseUrl, sessionId = SESSION_ID, tool = 'Read') {
  await postJson(`${baseUrl}/api/turn-end`, { session_id: sessionId });
  await postJson(`${baseUrl}/api/hooks`, { tool_name: tool, session_id: sessionId });
}

test('single forced continuation → amber badge "1 reopened" on Current Prompt', async () => {
  await withDashboard(async ({ page, baseUrl }) => {
    await seedLiveSession(baseUrl);
    await page.waitForTimeout(300);
    await fireForcedContinuation(baseUrl);
    await page.waitForTimeout(400);

    // Open Details sub-tab to reveal CurrentPrompt
    const detailsBtn = page.locator('button:has-text("Details")').first();
    await detailsBtn.click();
    await page.waitForTimeout(200);

    const badge = page.locator('[data-testid="forced-continuation-badge"]');
    await badge.waitFor({ timeout: 2000 });
    const text = await badge.textContent();
    assert.ok(text.includes('reopened'), `expected badge to include 'reopened', got '${text}'`);
    // Banner should NOT appear with only 1 consecutive
    const bannerCount = await page.locator('[data-testid="forced-continuation-banner"]').count();
    assert.strictEqual(bannerCount, 0, 'banner should only appear at >=2 consecutive');
  });
});

test('two consecutive forced continuations → red "possible Stop-hook loop" banner', async () => {
  await withDashboard(async ({ page, baseUrl }) => {
    const sid = 'browser-fc-loop';
    await seedLiveSession(baseUrl, sid);
    await page.waitForTimeout(300);
    await fireForcedContinuation(baseUrl, sid);
    await page.waitForTimeout(200);
    await fireForcedContinuation(baseUrl, sid, 'Bash');
    await page.waitForTimeout(400);

    const banner = page.locator('[data-testid="forced-continuation-banner"]');
    await banner.waitFor({ timeout: 2000 });
    const text = await banner.textContent();
    assert.ok(text.toLowerCase().includes('stop-hook loop'), `expected banner text, got '${text}'`);
    assert.ok(text.includes('2'), `expected banner to include count 2, got '${text}'`);
  });
});

summary();

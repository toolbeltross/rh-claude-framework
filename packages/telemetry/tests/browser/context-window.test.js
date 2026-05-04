/**
 * Browser test: ContextWindow component renders fill percentage and color band
 * correctly in response to seeded liveSession data.
 */
import assert from 'assert';
import { test, summary, afterAll } from '../helpers/test-harness.js';
import { withDashboard, closeBrowser } from './harness.js';
import { postJson } from '../helpers/server.js';

afterAll(closeBrowser);

console.log('context-window browser tests:\n');

const SESSION_ID = 'browser-ctx-test';

function statusPayload({ pct, totalInput }) {
  return {
    session_id: SESSION_ID,
    model: { id: 'claude-opus-4-6', display_name: 'Opus 4.6' },
    cost: { total_cost_usd: 1.0 },
    context_window: {
      context_window_size: 200000,
      total_input_tokens: totalInput,
      used_percentage: pct,
      current_usage: {
        input_tokens: 1000,
        output_tokens: 100,
        cache_read_input_tokens: Math.max(0, totalInput - 1000),
        cache_creation_input_tokens: 0,
      },
    },
    workspace: { current_dir: '/tmp/browser-test' },
    _source: 'statusLine',
  };
}

test('seeded 50% fill renders the percentage in the header', async () => {
  await withDashboard(async ({ page, baseUrl }) => {
    await postJson(`${baseUrl}/api/status`, statusPayload({ pct: 50, totalInput: 100000 }));
    // Wait for the percentage to appear in the context window section
    await page.waitForSelector('text=/50%/', { timeout: 3000 });
    const found = await page.locator('text=/50%/').count();
    assert.ok(found > 0, '50% should appear in context window');
  });
});

test('seeded 85% fill applies red color band', async () => {
  await withDashboard(async ({ page, baseUrl }) => {
    await postJson(`${baseUrl}/api/status`, statusPayload({ pct: 85, totalInput: 170000 }));
    await page.waitForSelector('text=/85%/', { timeout: 3000 });
    // The bar should have a red class somewhere in the rendered tree
    const redBar = await page.locator('div.bg-red').count();
    assert.ok(redBar > 0, 'expected at least one bg-red element at 85% fill');
  });
});

test('total tokens display matches seeded value', async () => {
  await withDashboard(async ({ page, baseUrl }) => {
    await postJson(`${baseUrl}/api/status`, statusPayload({ pct: 40, totalInput: 80000 }));
    await page.waitForSelector('text=/40%/', { timeout: 3000 });
    // 80K should appear somewhere in the context window section
    const tokenText = await page.locator('text=/80K/').count();
    assert.ok(tokenText > 0, '80K token count should be displayed');
  });
});

test('used_percentage shown when total_input_tokens is low (early session)', async () => {
  await withDashboard(async ({ page, baseUrl }) => {
    // total_input_tokens=356 computes to 0% of 200K, but used_percentage=6 — should show 6%
    await postJson(`${baseUrl}/api/status`, statusPayload({ pct: 6, totalInput: 356 }));
    await page.waitForSelector('text=/6%/', { timeout: 3000 });
    const found = await page.locator('text=/6%/').count();
    assert.ok(found > 0, '6% from used_percentage should appear, not 0% from tokens');
  });
});

summary();

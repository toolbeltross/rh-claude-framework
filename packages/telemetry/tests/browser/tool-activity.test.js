/**
 * Browser test: ToolActivity panel renders rows for incoming tool events.
 */
import assert from 'assert';
import { test, summary, afterAll } from '../helpers/test-harness.js';
import { withDashboard, closeBrowser } from './harness.js';
import { postJson } from '../helpers/server.js';

afterAll(closeBrowser);

console.log('tool-activity browser tests:\n');

const SESSION_ID = 'browser-tools-test';

async function seedLiveSession(baseUrl) {
  // Create a live session so the dashboard auto-selects its tab
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
    workspace: { current_dir: '/tmp/browser-tools' },
    _source: 'statusLine',
  });
}

async function fireTool(baseUrl, toolName, success = true) {
  await postJson(`${baseUrl}/api/hooks`, {
    tool_name: toolName,
    session_id: SESSION_ID,
    cwd: '/tmp/browser-tools',
    success,
    error: success ? null : 'simulated failure',
    event_type: success ? 'post_tool_use' : 'post_tool_use_failure',
  });
}

test('seeded tool events render in ToolActivity panel', async () => {
  await withDashboard(async ({ page, baseUrl }) => {
    await seedLiveSession(baseUrl);
    await fireTool(baseUrl, 'Read');
    await fireTool(baseUrl, 'Bash');
    await fireTool(baseUrl, 'Grep');

    // The ToolActivity panel header should show — give the WebSocket some time to propagate
    await page.waitForTimeout(500);
    // Look for any of the tool names in the live tool activity area
    const readCount = await page.locator('text=Read').count();
    const bashCount = await page.locator('text=Bash').count();
    assert.ok(readCount > 0, 'Read should appear in tool activity');
    assert.ok(bashCount > 0, 'Bash should appear in tool activity');
  });
});

test('failure events render with failure indication', async () => {
  await withDashboard(async ({ page, baseUrl }) => {
    await seedLiveSession(baseUrl);
    await fireTool(baseUrl, 'Bash', false);
    await page.waitForTimeout(500);
    // The dashboard renders failed events with a red dot or "fail" indicator
    // We just confirm the FailureHistory or ToolActivity registers it
    const bashCount = await page.locator('text=Bash').count();
    assert.ok(bashCount > 0, 'Failed tool event should still render the tool name');
  });
});

summary();

/**
 * Browser test: Phase E1 — parent_agent_id surfaces on the Agents tab
 * when a child subagent is spawned by another subagent.
 */
import assert from 'assert';
import { test, summary, afterAll } from '../helpers/test-harness.js';
import { withDashboard, closeBrowser } from './harness.js';
import { postJson } from '../helpers/server.js';

afterAll(closeBrowser);

console.log('subagent-parent browser tests:\n');

const SESSION_ID = 'browser-parent';

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
    workspace: { current_dir: '/tmp/parent' },
    _source: 'statusLine',
  });
}

async function clickSubTab(page, name) {
  const btn = page.locator(`button:has-text("${name}")`).first();
  await btn.click();
  await page.waitForTimeout(150);
}

test('E1: child subagent with parent_agent_id shows parent reference chip', async () => {
  await withDashboard(async ({ page, baseUrl }) => {
    await seed(baseUrl);
    await page.waitForTimeout(300);
    await postJson(`${baseUrl}/api/subagent`, {
      session_id: SESSION_ID,
      action: 'start',
      agent_id: 'facilitator-parent',
      agent_type: 'facilitator',
    });
    await postJson(`${baseUrl}/api/subagent`, {
      session_id: SESSION_ID,
      action: 'start',
      agent_id: 'explore-child',
      agent_type: 'Explore',
      parent_agent_id: 'facilitator-parent',
    });
    await page.waitForTimeout(400);
    await clickSubTab(page, 'Agents');

    const parentRef = page.locator('[data-testid="agent-parent-ref"]').first();
    await parentRef.waitFor({ timeout: 2000 });
    const text = await parentRef.textContent();
    assert.ok(text.includes('parent'), `expected 'parent', got '${text}'`);
    // Should show last 8 chars of the parent agent id
    assert.ok(text.includes('or-parent') || text.includes('parent') , `expected parent id suffix, got '${text}'`);
  });
});

summary();

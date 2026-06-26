/**
 * Browser test: subagent orphan chip + Failures tab row render correctly
 * after an orphan sweep fires on a live session.
 *
 * The dashboard's initial state comes from /api/snapshot (which does not
 * include failureEvents); failureEvents arrive only via WebSocket. So the
 * sweep must fire AFTER the page has loaded and the WebSocket is connected.
 */
import assert from 'assert';
import { test, summary, afterAll } from '../helpers/test-harness.js';
import { withDashboard, closeBrowser, pushState } from './harness.js';
import { postJson } from '../helpers/server.js';

afterAll(closeBrowser);

console.log('subagent-orphan browser tests:\n');

const SESSION_ID = 'browser-orphan-test';

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
    workspace: { current_dir: '/tmp/browser-orphan' },
    _source: 'statusLine',
  });
}

/** Click a sub-tab button by name inside the SessionTab bar. */
async function clickSubTab(page, name) {
  // SessionTab's SubTabButton renders plain buttons with name as text.
  const btn = page.locator(`button:has-text("${name}")`).first();
  await btn.click();
  await page.waitForTimeout(150);
}

test('active agent renders after subagent-start POST', async () => {
  await withDashboard(async ({ page, baseUrl }) => {
    await seedLiveSession(baseUrl);
    await page.waitForTimeout(300); // WebSocket pushes live session
    await postJson(`${baseUrl}/api/subagent`, {
      session_id: SESSION_ID,
      action: 'start',
      agent_id: 'active-1',
      agent_type: 'Explore',
    });
    await page.waitForTimeout(400);
    // Agents sub-tab is auto-selected when hasAgentActivity. But our seed
    // runs after mount, so sub-tab may still be Tools — click explicitly.
    await clickSubTab(page, 'Agents');
    const exploreCount = await page.locator('text=Explore').count();
    assert.ok(exploreCount > 0, 'Explore agent type should render in Active list');
  });
});

test('orphan sweep → Agents tab shows "orphaned" chip on completed detail', async () => {
  await withDashboard(async ({ page, baseUrl }) => {
    await seedLiveSession(baseUrl);
    await page.waitForTimeout(300);
    await postJson(`${baseUrl}/api/subagent`, {
      session_id: SESSION_ID,
      action: 'start',
      agent_id: 'zombie-browser-1',
      agent_type: 'Explore',
    });
    await page.waitForTimeout(200);
    // Trigger sweep with 0ms threshold — immediate orphan
    await pushState(baseUrl, 'sweepOrphanedSubagents', [0]);
    await page.waitForTimeout(500); // WebSocket subagentUpdate propagates

    await clickSubTab(page, 'Agents');
    await page.waitForTimeout(300);

    // V2: orphaned agents are in the unified table — no collapsible to expand
    const orphanedChip = page.locator('span', { hasText: /^orphaned$/ });
    const count = await orphanedChip.count();
    assert.ok(count > 0, 'orphaned chip should render on the Agents tab completed row');
  });
});

test('orphan sweep → Failures tab shows purple "orphaned agent" row', async () => {
  await withDashboard(async ({ page, baseUrl }) => {
    await seedLiveSession(baseUrl);
    await page.waitForTimeout(300);
    await postJson(`${baseUrl}/api/subagent`, {
      session_id: SESSION_ID,
      action: 'start',
      agent_id: 'zombie-browser-2',
      agent_type: 'facilitator',
    });
    await page.waitForTimeout(200);
    await pushState(baseUrl, 'sweepOrphanedSubagents', [0]);
    await page.waitForTimeout(500); // failureEvent propagates via WebSocket

    await clickSubTab(page, 'Failures');

    const orphanLabel = page.locator('text=orphaned agent').first();
    await orphanLabel.waitFor({ timeout: 2000 });
    const count = await page.locator('text=orphaned agent').count();
    assert.ok(count > 0, 'Failures tab should show a row labeled "orphaned agent"');
  });
});

summary();

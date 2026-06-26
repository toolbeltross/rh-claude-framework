/**
 * Browser test: Phase C4 — SubagentTimeline renders gantt-lite lanes + overlays.
 */
import assert from 'assert';
import { test, summary, afterAll } from '../helpers/test-harness.js';
import { withDashboard, closeBrowser } from './harness.js';
import { postJson } from '../helpers/server.js';

afterAll(closeBrowser);

console.log('subagent-timeline browser tests:\n');

const SESSION_ID = 'browser-timeline';

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
    workspace: { current_dir: '/tmp/timeline' },
    _source: 'statusLine',
  });
}

async function clickSubTab(page, name) {
  const btn = page.locator(`button:has-text("${name}")`).first();
  await btn.click();
  await page.waitForTimeout(150);
}

test('Timeline collapsed by default, expands to show an active agent lane', async () => {
  await withDashboard(async ({ page, baseUrl }) => {
    await seed(baseUrl);
    await page.waitForTimeout(300);
    await postJson(`${baseUrl}/api/subagent`, {
      session_id: SESSION_ID,
      action: 'start',
      agent_id: 'tl-ag-1',
      agent_type: 'Explore',
    });
    await page.waitForTimeout(400);
    await clickSubTab(page, 'Agents');
    await page.waitForTimeout(200);

    // Timeline is behind a header toggle — not visible initially
    const timelineBefore = await page.locator('[data-testid="subagent-timeline"]').count();
    assert.strictEqual(timelineBefore, 0, 'Timeline should not render until header toggle is clicked');

    // Click the "▾ timeline" toggle in the header strip
    const timelineToggle = page.locator('[data-testid="timeline-toggle"]').first();
    await timelineToggle.click();
    await page.waitForTimeout(300);

    const timeline = page.locator('[data-testid="subagent-timeline"]');
    await timeline.waitFor({ timeout: 2000 });

    // SubagentTimeline mounts defaultExpanded=true, so SVG should render immediately
    const svgCount = await timeline.locator('svg').count();
    assert.ok(svgCount > 0, 'SVG should render after header toggle click');

    const activeLane = await timeline.locator('[data-testid="timeline-lane-active"]').count();
    assert.ok(activeLane > 0, 'active lane should render for the running agent');
  });
});

test('Timeline renders compaction vertical line when a compact event fires', async () => {
  await withDashboard(async ({ page, baseUrl }) => {
    await seed(baseUrl);
    await page.waitForTimeout(300);
    await postJson(`${baseUrl}/api/subagent`, {
      session_id: SESSION_ID,
      action: 'start',
      agent_id: 'tl-ag-2',
      agent_type: 'Plan',
    });
    await page.waitForTimeout(200);
    await postJson(`${baseUrl}/api/compact`, {
      session_id: SESSION_ID,
      trigger: 'auto',
    });
    await page.waitForTimeout(400);
    await clickSubTab(page, 'Agents');
    await page.waitForTimeout(200);

    // Click the "▾ timeline" toggle in the header strip
    const timelineToggle = page.locator('[data-testid="timeline-toggle"]').first();
    await timelineToggle.click();
    await page.waitForTimeout(300);

    const timeline = page.locator('[data-testid="subagent-timeline"]');
    await timeline.waitFor({ timeout: 2000 });

    const compactLines = await timeline.locator('[data-testid="timeline-compact-line"]').count();
    assert.ok(compactLines > 0, 'at least one compaction vertical line should render');
  });
});

summary();

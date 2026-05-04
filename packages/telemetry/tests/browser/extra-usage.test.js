/**
 * Browser test: Extra Usage rendering in PlanUsage bar and SessionMetaStrip.
 * Verifies the dashboard shows correct dollar amounts, progress bar, and
 * ACTIVE indicator when plan limits are hit.
 */
import assert from 'assert';
import { test, summary, afterAll } from '../helpers/test-harness.js';
import { withDashboard, pushState, closeBrowser } from './harness.js';
import { postJson } from '../helpers/server.js';

afterAll(closeBrowser);

console.log('extra-usage browser tests:\n');

const SESSION_ID = 'browser-extra-test';

function statusPayload() {
  return {
    session_id: SESSION_ID,
    model: { id: 'claude-opus-4-6', display_name: 'Opus 4.6' },
    cost: { total_cost_usd: 5.0 },
    context_window: {
      context_window_size: 200000,
      total_input_tokens: 80000,
      used_percentage: 40,
    },
    workspace: { current_dir: '/tmp/extra-test' },
    _source: 'statusLine',
  };
}

function planInfoWithExtra({ fiveHourUtil = 50, extraUsedCents = 26688, extraLimitCents = 5000 }) {
  return {
    planType: 'max',
    rateLimitTier: 'default_claude_max_20x',
    displayMode: 'tokens',
    tierName: 'Max 20x',
    usage: {
      fiveHour: { utilization: fiveHourUtil, resets_at: new Date(Date.now() + 3600000).toISOString() },
      sevenDay: { utilization: 50, resets_at: new Date(Date.now() + 86400000).toISOString() },
      sevenDaySonnet: null,
      extraUsage: {
        is_enabled: true,
        monthly_limit: extraLimitCents,
        used_credits: extraUsedCents,
        utilization: Math.min(100, Math.round((extraUsedCents / extraLimitCents) * 100)),
        currency: 'USD',
      },
    },
    usageSource: 'oauth_api',
    usageTimestamp: Date.now(),
  };
}

test('Extra Usage dollar amount renders in cents-to-dollars format', async () => {
  await withDashboard(async ({ page, baseUrl }) => {
    await postJson(`${baseUrl}/api/status`, statusPayload());
    await pushState(baseUrl, 'updatePlanInfo', [planInfoWithExtra({ extraUsedCents: 26688 })]);
    // $266.88 = 26688 cents / 100. Use escaped $ in regex.
    await page.waitForSelector('text=/\\$266\\.88/', { timeout: 5000 });
    const found = await page.locator('text=/\\$266\\.88/').count();
    assert.ok(found > 0, 'should render $266.88 (26688 cents → dollars)');
  });
});

test('Extra Usage progress bar renders toward monthly cap', async () => {
  await withDashboard(async ({ page, baseUrl }) => {
    await postJson(`${baseUrl}/api/status`, statusPayload());
    await pushState(baseUrl, 'updatePlanInfo', [planInfoWithExtra({ extraUsedCents: 2500, extraLimitCents: 5000 })]);
    // $25.00 used of $50.00 limit
    await page.waitForSelector('text=/\\$25\\.00/', { timeout: 5000 });
    // Monthly cap label should show $50
    const capLabel = await page.locator('text=/\\$50/').count();
    assert.ok(capLabel > 0, 'should show $50 monthly cap');
  });
});

test('Extra Usage shows ACTIVE with pulsing dot when gauge at 100%', async () => {
  await withDashboard(async ({ page, baseUrl }) => {
    await postJson(`${baseUrl}/api/status`, statusPayload());
    await pushState(baseUrl, 'updatePlanInfo', [planInfoWithExtra({ fiveHourUtil: 100, extraUsedCents: 26688 })]);
    await page.waitForSelector('text=/ACTIVE/', { timeout: 5000 });
    const activeLabel = await page.locator('text=/ACTIVE/').count();
    assert.ok(activeLabel > 0, 'should show ACTIVE when a gauge hits 100%');
    const pulsingDot = await page.locator('.animate-pulse-dot.bg-amber').count();
    assert.ok(pulsingDot > 0, 'should show pulsing amber dot when extra usage is active');
  });
});

test('Extra Usage shows ON (not ACTIVE) when no gauge at 100%', async () => {
  await withDashboard(async ({ page, baseUrl }) => {
    await postJson(`${baseUrl}/api/status`, statusPayload());
    await pushState(baseUrl, 'updatePlanInfo', [planInfoWithExtra({ fiveHourUtil: 50, extraUsedCents: 1000 })]);
    await page.waitForSelector('text=/\\$10\\.00/', { timeout: 5000 });
    const onLabels = await page.getByText('ON', { exact: true }).count();
    assert.ok(onLabels > 0, 'should show ON when no gauge is at 100%');
  });
});

test('Extra Usage OFF renders when disabled', async () => {
  await withDashboard(async ({ page, baseUrl }) => {
    await postJson(`${baseUrl}/api/status`, statusPayload());
    const info = planInfoWithExtra({});
    info.usage.extraUsage.is_enabled = false;
    await pushState(baseUrl, 'updatePlanInfo', [info]);
    await page.waitForSelector('text=/OFF/', { timeout: 5000 });
    const offLabel = await page.getByText('OFF', { exact: true }).count();
    assert.ok(offLabel > 0, 'should show OFF when extra usage is disabled');
  });
});

summary();

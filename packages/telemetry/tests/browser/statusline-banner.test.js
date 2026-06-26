/**
 * Browser test: StatusLineBanner appears/disappears on statusLineState changes.
 *
 * Uses the test-only /api/_test/state endpoint to push synthetic state, then
 * asserts the banner DOM reflects it.
 *
 * Selectors use data-testid so the test survives label tweaks (the banner
 * display text was changed mid-refactor from "statusLine issue" to the
 * current compact "statusLine"/"stalled" labels without updating these tests
 * — we now anchor on the testid and check labels via textContent / dataset).
 */
import assert from 'assert';
import { test, summary, afterAll } from '../helpers/test-harness.js';
import { withDashboard, pushState, closeBrowser } from './harness.js';

afterAll(closeBrowser);

console.log('statusline-banner browser tests:\n');

const BTN = '[data-testid="statusline-banner-button"]';
const MODAL = '[data-testid="statusline-modal"]';

test('healthy state shows no banner', async () => {
  await withDashboard(async ({ page }) => {
    // Healthy fixture is the default — no banner should be visible
    const banner = await page.locator(BTN).count();
    assert.strictEqual(banner, 0, 'banner should not appear when healthy');
  });
});

test('unknown-custom state surfaces an amber banner', async () => {
  await withDashboard(async ({ page, baseUrl }) => {
    await pushState(baseUrl, 'updateStatusLineState', [{
      class: 'unknown-custom',
      command: 'node /tmp/custom.js',
      reason: 'custom statusLine script (not forwarding to telemetry)',
    }]);
    await page.waitForSelector(BTN, { timeout: 3000 });
    const cls = await page.locator(BTN).first().getAttribute('data-class');
    assert.strictEqual(cls, 'unknown-custom');
    const text = await page.locator(BTN).first().textContent();
    assert.ok(/statusLine/i.test(text), `expected 'statusLine' label, got '${text}'`);
  });
});

test('placeholder state surfaces a banner', async () => {
  await withDashboard(async ({ page, baseUrl }) => {
    await pushState(baseUrl, 'updateStatusLineState', [{
      class: 'placeholder',
      command: 'node /old/placeholder.js',
      reason: 'legacy fallback script detected',
    }]);
    await page.waitForSelector(BTN, { timeout: 3000 });
    const cls = await page.locator(BTN).first().getAttribute('data-class');
    assert.strictEqual(cls, 'placeholder');
  });
});

test('stalled flag surfaces a red stall banner', async () => {
  await withDashboard(async ({ page, baseUrl }) => {
    // Stall is a flag on top of an otherwise-healthy class
    await pushState(baseUrl, 'updateStatusLineState', [{
      class: 'telemetry',
      stalled: true,
    }]);
    await page.waitForSelector(BTN, { timeout: 3000 });
    const stalled = await page.locator(BTN).first().getAttribute('data-stalled');
    assert.strictEqual(stalled, 'true', 'data-stalled attribute should be "true"');
    const text = await page.locator(BTN).first().textContent();
    assert.ok(/stalled/i.test(text), `expected 'stalled' label, got '${text}'`);
  });
});

test('clearing class back to telemetry hides the banner', async () => {
  await withDashboard(async ({ page, baseUrl }) => {
    await pushState(baseUrl, 'updateStatusLineState', [{ class: 'unknown-custom', command: 'node /x.js' }]);
    await page.waitForSelector(BTN, { timeout: 3000 });

    await pushState(baseUrl, 'updateStatusLineState', [{ class: 'telemetry', stalled: false }]);
    // Banner should disappear within a few hundred ms
    await page.waitForSelector(BTN, { state: 'detached', timeout: 3000 });

    const count = await page.locator(BTN).count();
    assert.strictEqual(count, 0);
  });
});

test('clicking the banner opens a modal with command + repair instructions', async () => {
  await withDashboard(async ({ page, baseUrl }) => {
    await pushState(baseUrl, 'updateStatusLineState', [{
      class: 'unknown-custom',
      command: 'node /tmp/sample-custom.js',
      reason: 'custom statusLine script',
    }]);
    await page.waitForSelector(BTN, { timeout: 3000 });
    await page.locator(BTN).first().click();

    // Modal root + contents
    await page.waitForSelector(MODAL, { timeout: 2000 });
    await page.waitForSelector('text=/sample-custom\\.js/', { timeout: 2000 });
    await page.waitForSelector('text=/repair-statusline/', { timeout: 2000 });
  });
});

summary();

/**
 * Browser test harness — spawns a built dashboard server in test mode and
 * launches a Playwright Chromium instance against it.
 *
 * Reuses the spawn-server pattern from tests/helpers/server.js (which gives us
 * tmp HOME isolation) and adds Playwright on top.
 *
 * Each browser test creates its own server + browser context. Tests run
 * sequentially (no parallel — Playwright Chromium startup is the bottleneck).
 */
import { chromium } from 'playwright';
import { mkdirSync, copyFileSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { withTmp } from '../helpers/tmp.js';
import { startTestServer, postJson } from '../helpers/server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..');
const FIXTURES = resolve(__dirname, '..', 'fixtures');
const DIST_PATH = join(PROJECT_ROOT, 'dist');

let browserInstance = null;

async function getBrowser() {
  if (!browserInstance) {
    browserInstance = await chromium.launch({ headless: !process.argv.includes('--headed') });
  }
  return browserInstance;
}

export async function closeBrowser() {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}

/**
 * Run `fn(server, page)` against a freshly-spawned server and a new
 * Playwright page. Server has RH_TELEMETRY_TEST_MODE=1 so /api/_test/state
 * is mounted. Tmp HOME, ephemeral port, full isolation.
 *
 * Requires `npm run build` to have been run at least once so dist/ exists.
 */
export async function withDashboard(fn) {
  if (!existsSync(DIST_PATH)) {
    throw new Error(
      `dist/ not found at ${DIST_PATH}. Run 'npm run build' before running browser tests.`
    );
  }

  await withTmp(async (home) => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    copyFileSync(join(FIXTURES, 'settings/healthy.json'), join(home, '.claude', 'settings.json'));

    const server = await startTestServer({
      tmpHome: home,
      extraEnv: { RH_TELEMETRY_TEST_MODE: '1' },
    });

    const browser = await getBrowser();
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await page.goto(server.baseUrl, { waitUntil: 'networkidle', timeout: 5000 });
      await fn({ server, page, baseUrl: server.baseUrl });
    } finally {
      await context.close();
      await server.stop();
    }
  }, 'browser');
}

/**
 * Push a synthetic state mutation through the test-only debug endpoint.
 * @param {string} baseUrl
 * @param {string} method - store method name (e.g. 'updateStatusLineState')
 * @param {Array} args - arguments to pass to the method
 */
export async function pushState(baseUrl, method, args) {
  return postJson(`${baseUrl}/api/_test/state`, { method, args });
}

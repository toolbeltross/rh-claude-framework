/**
 * Visual-verification driver for the v2 dashboard surfaces.
 * Navigates :7894 (RH_TELEMETRY_UI=v2), clicks through every sidebar surface,
 * captures a screenshot per surface + all console errors.
 *
 * Usage: node docs/screenshots/v2/capture-surfaces.mjs [port] [outDir]
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const port = process.argv[2] || '7894';
const outDir = process.argv[3] || dirname(fileURLToPath(import.meta.url));
mkdirSync(outDir, { recursive: true });

const SURFACES = ['Live', 'Sessions', 'Subagents', 'Oversight', 'Failures', 'Trends', 'History'];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

await page.goto(`http://localhost:${port}/`, { waitUntil: 'networkidle' });

for (const surface of SURFACES) {
  await page.getByRole('button', { name: surface, exact: true }).click();
  await page.waitForTimeout(1500); // fetch + render settle
  const file = join(outDir, `0x-${surface.toLowerCase()}.png`);
  await page.screenshot({ path: file });
  // Cheap DOM probe: is the surface showing the placeholder scaffold?
  const placeholder = await page.getByText('Surface scaffold — implementation pending').count();
  const bodyChars = (await page.locator('main').innerText()).length;
  console.log(`${surface}: screenshot saved, placeholder=${placeholder}, mainTextChars=${bodyChars}`);
}

console.log(`\nconsole errors: ${consoleErrors.length}`);
for (const e of consoleErrors) console.log('  ERROR:', e);

await browser.close();
process.exit(consoleErrors.length > 0 ? 2 : 0);

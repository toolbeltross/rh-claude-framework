/**
 * Captures screenshots of the dashboard at various views using Playwright.
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { join } from 'path';

/**
 * @param {string} baseUrl - The server URL to screenshot
 * @param {string} outputDir - Directory to save screenshots
 * @param {string} label - Prefix for filenames (e.g., 'dev' or 'prod')
 * @returns {Promise<string[]>} Array of saved screenshot paths
 */
export async function captureViews(baseUrl, outputDir, label) {
  mkdirSync(outputDir, { recursive: true });

  const browser = await chromium.launch({
    args: ['--font-render-hinting=none'],
  });

  const screenshots = [];

  try {
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();

    // Disable animations for deterministic screenshots
    await page.addInitScript(() => {
      const style = document.createElement('style');
      style.textContent = '*, *::before, *::after { animation: none !important; transition: none !important; }';
      document.head.appendChild(style);
    });

    // Navigate to dashboard
    await page.goto(baseUrl, { waitUntil: 'networkidle' });

    // Wait for WebSocket connection (green dot in footer)
    await page.waitForTimeout(2000);

    // Wait for fonts
    await page.evaluate(() => document.fonts.ready);

    // 1. Session tab (auto-selected when live session exists)
    await page.waitForTimeout(2500); // Recharts settle
    const sessionPath = join(outputDir, `${label}-session.png`);
    await page.screenshot({ path: sessionPath, fullPage: true });
    screenshots.push(sessionPath);
    console.log(`  [screenshot] ${label}-session.png`);

    // 2. Overview tab — click the overflow "⋯" menu, then "Overview"
    const overflowBtn = page.locator('button:has-text("⋯")');
    if (await overflowBtn.count() > 0) {
      await overflowBtn.click();
      await page.waitForTimeout(300);
      const overviewBtn = page.locator('button:has-text("Overview")');
      if (await overviewBtn.count() > 0) {
        await overviewBtn.click();
        await page.waitForTimeout(2500); // Charts settle
        const overviewPath = join(outputDir, `${label}-overview.png`);
        await page.screenshot({ path: overviewPath, fullPage: true });
        screenshots.push(overviewPath);
        console.log(`  [screenshot] ${label}-overview.png`);
      }
    }

    // 3. Micro mode — resize viewport to trigger MICRO_THRESHOLD (480px)
    await page.setViewportSize({ width: 380, height: 600 });
    await page.waitForTimeout(1500);
    const microPath = join(outputDir, `${label}-micro.png`);
    await page.screenshot({ path: microPath, fullPage: true });
    screenshots.push(microPath);
    console.log(`  [screenshot] ${label}-micro.png`);

    await context.close();
  } finally {
    await browser.close();
  }

  return screenshots;
}
/**
 * Generates an HTML report with side-by-side comparison and diff overlay.
 */

import { writeFileSync, readFileSync } from 'fs';
import { join, relative } from 'path';

/**
 * @param {Array<{ name: string, diffPixels: number, totalPixels: number, diffPercent: number, diffImagePath: string, passed: boolean }>} results
 * @param {string} outputDir
 * @returns {string} Path to the generated report
 */
export function generateReport(results, outputDir) {
  const allPassed = results.every(r => r.passed);
  const reportPath = join(outputDir, 'report.html');

  const rows = results.map(r => {
    const devImg = relative(outputDir, join(outputDir, `dev-${r.name}.png`));
    const prodImg = relative(outputDir, join(outputDir, `prod-${r.name}.png`));
    const diffImg = relative(outputDir, r.diffImagePath);

    return `
      <div class="comparison">
        <h2>
          <span class="status ${r.passed ? 'pass' : 'fail'}">${r.passed ? 'PASS' : 'FAIL'}</span>
          ${r.name}
          <span class="stats">${r.diffPercent}% diff (${r.diffPixels.toLocaleString()} / ${r.totalPixels.toLocaleString()} pixels)</span>
        </h2>
        <div class="images">
          <div class="img-col">
            <h3>Dev (Vite :5173)</h3>
            <img src="${devImg}" alt="Dev ${r.name}" />
          </div>
          <div class="img-col">
            <h3>Prod (Express :7891)</h3>
            <img src="${prodImg}" alt="Prod ${r.name}" />
          </div>
          <div class="img-col">
            <h3>Diff</h3>
            <img src="${diffImg}" alt="Diff ${r.name}" />
          </div>
        </div>
      </div>`;
  }).join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Visual Parity Report</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #0a0a0a; color: #e5e5e5; padding: 24px; }
    h1 { font-size: 24px; margin-bottom: 8px; }
    .summary { font-size: 14px; color: #888; margin-bottom: 24px; }
    .summary .result { font-weight: bold; color: ${allPassed ? '#34d399' : '#f87171'}; }
    .comparison { border: 1px solid #333; border-radius: 8px; padding: 16px; margin-bottom: 24px; background: #111; }
    .comparison h2 { font-size: 16px; margin-bottom: 12px; display: flex; align-items: center; gap: 12px; }
    .status { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; }
    .status.pass { background: #34d39922; color: #34d399; }
    .status.fail { background: #f8717122; color: #f87171; }
    .stats { font-size: 12px; color: #666; font-weight: normal; margin-left: auto; }
    .images { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
    .img-col h3 { font-size: 12px; color: #888; margin-bottom: 6px; }
    .img-col img { width: 100%; border: 1px solid #333; border-radius: 4px; }
    .timestamp { font-size: 11px; color: #555; margin-top: 16px; }
  </style>
</head>
<body>
  <h1>Visual Parity Report</h1>
  <p class="summary">
    <span class="result">${allPassed ? 'ALL PASSED' : 'DIFFERENCES FOUND'}</span>
    — ${results.length} view${results.length !== 1 ? 's' : ''} compared, threshold: 0.5%
  </p>
  ${rows}
  <p class="timestamp">Generated: ${new Date().toISOString()}</p>
</body>
</html>`;

  writeFileSync(reportPath, html);
  return reportPath;
}
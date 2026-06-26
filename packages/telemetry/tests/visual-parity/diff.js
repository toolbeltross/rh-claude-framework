/**
 * Compares screenshot pairs using pixelmatch.
 */

import { readFileSync, writeFileSync } from 'fs';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { join, basename } from 'path';

/**
 * @param {string} devPath - Path to dev screenshot
 * @param {string} prodPath - Path to prod screenshot
 * @param {string} outputDir - Directory to save diff image
 * @param {number} threshold - pixelmatch threshold (0-1, lower = stricter). Default 0.1
 * @returns {{ name: string, diffPixels: number, totalPixels: number, diffPercent: number, diffImagePath: string, passed: boolean }}
 */
export function compareImages(devPath, prodPath, outputDir, threshold = 0.1) {
  const devImg = PNG.sync.read(readFileSync(devPath));
  const prodImg = PNG.sync.read(readFileSync(prodPath));

  // Handle size mismatches by using the larger dimensions
  const width = Math.max(devImg.width, prodImg.width);
  const height = Math.max(devImg.height, prodImg.height);

  // Resize images to common canvas if needed
  const devData = resizeToCanvas(devImg, width, height);
  const prodData = resizeToCanvas(prodImg, width, height);

  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(devData, prodData, diff.data, width, height, {
    threshold,
    includeAA: false, // Ignore anti-aliasing differences
  });

  const totalPixels = width * height;
  const diffPercent = (diffPixels / totalPixels) * 100;

  const name = basename(devPath).replace('dev-', '').replace('.png', '');
  const diffImagePath = join(outputDir, `diff-${name}.png`);
  writeFileSync(diffImagePath, PNG.sync.write(diff));

  return {
    name,
    diffPixels,
    totalPixels,
    diffPercent: Math.round(diffPercent * 100) / 100,
    diffImagePath,
    passed: diffPercent < 0.5, // < 0.5% pixel diff = pass
  };
}

/**
 * Copies image data onto a larger canvas, filling extra space with transparent black.
 */
function resizeToCanvas(img, targetWidth, targetHeight) {
  if (img.width === targetWidth && img.height === targetHeight) {
    return img.data;
  }
  const buf = Buffer.alloc(targetWidth * targetHeight * 4, 0);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const srcIdx = (y * img.width + x) * 4;
      const dstIdx = (y * targetWidth + x) * 4;
      buf[dstIdx] = img.data[srcIdx];
      buf[dstIdx + 1] = img.data[srcIdx + 1];
      buf[dstIdx + 2] = img.data[srcIdx + 2];
      buf[dstIdx + 3] = img.data[srcIdx + 3];
    }
  }
  return buf;
}
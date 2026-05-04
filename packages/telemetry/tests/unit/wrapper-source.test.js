/**
 * Tests for scripts/generate-statusline-wrapper.js — buildWrapperSource()
 *
 * Verifies the generated source has the right marker, escapes paths
 * correctly, and parses as valid JavaScript.
 */
import assert from 'assert';
import { execFileSync } from 'child_process';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { test, summary } from '../helpers/test-harness.js';
import { withTmp } from '../helpers/tmp.js';
import { buildWrapperSource } from '../../scripts/generate-statusline-wrapper.js';

console.log('wrapper-source tests:\n');

test('first two lines contain rh-telemetry:wrapped marker with original path', () => {
  const src = buildWrapperSource('/some/abs/path.js', 'http://localhost:7890');
  const firstTwo = src.split('\n').slice(0, 2).join('\n');
  assert.ok(firstTwo.includes('// rh-telemetry:wrapped'));
  assert.ok(firstTwo.includes('/some/abs/path.js'));
});

test('escapes Windows backslashes in original path literal', () => {
  const src = buildWrapperSource('C:\\Users\\rossb\\.claude\\scripts\\statusline.js', 'http://localhost:7890');
  // The source should contain a doubled-backslash form so the JS literal evaluates to the original
  assert.ok(src.includes("'C:\\\\Users\\\\rossb\\\\.claude\\\\scripts\\\\statusline.js'"));
});

test('escapes single quotes in path', () => {
  const src = buildWrapperSource("/weird'path/script.js", 'http://localhost:7890');
  assert.ok(src.includes("\\'"));
});

test('embeds the provided baseUrl', () => {
  const src = buildWrapperSource('/x/y.js', 'http://example.test:9999');
  assert.ok(src.includes("'http://example.test:9999'"));
});

test('contains a fire-and-forget POST with statusLineWrapped source tag', () => {
  const src = buildWrapperSource('/x/y.js', 'http://localhost:7890');
  assert.ok(src.includes('statusLineWrapped'));
  assert.ok(src.includes('/api/status'));
});

test('contains a 500ms POST_TIMEOUT', () => {
  const src = buildWrapperSource('/x/y.js', 'http://localhost:7890');
  assert.ok(/POST_TIMEOUT\s*=\s*500/.test(src));
});

test('generated source is parseable JavaScript (node --check)', async () => {
  await withTmp(async (tmpDir) => {
    const src = buildWrapperSource('/some/path.js', 'http://localhost:7890');
    const file = join(tmpDir, 'wrapper.js');
    writeFileSync(file, src);
    // node --check exits 0 if syntax is valid
    execFileSync('node', ['--check', file], { stdio: 'pipe' });
  }, 'wrapper-syntax');
});

test('generated source has shebang for direct execution', () => {
  const src = buildWrapperSource('/x/y.js', 'http://localhost:7890');
  assert.ok(src.startsWith('#!/usr/bin/env node'));
});

summary();

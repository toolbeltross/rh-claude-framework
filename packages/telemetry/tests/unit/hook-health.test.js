/**
 * Unit tests for server/hook-health.js (D5).
 */
import assert from 'assert';
import { join } from 'path';
import { writeFileSync } from 'fs';
import { test, summary } from '../helpers/test-harness.js';
import { withTmp } from '../helpers/tmp.js';
import { getHookHealth } from '../../server/hook-health.js';

console.log('hook-health tests:\n');

test('D5 getHookHealth: missing log → healthy:false, exists:false', async () => {
  await withTmp(async (tmp) => {
    const path = join(tmp, 'missing.log');
    const h = getHookHealth({ logPath: path });
    assert.strictEqual(h.exists, false);
    assert.strictEqual(h.healthy, false);
    assert.ok(h.reason.includes('not found'));
  }, 'd5-missing');
});

test('D5 getHookHealth: healthy log → healthy:true, no errors', async () => {
  await withTmp(async (tmp) => {
    const path = join(tmp, 'clean.log');
    const content = [
      '[2026-04-19T10:00:00.000Z] mode=tool args= post_tool_use',
      '[2026-04-19T10:00:01.000Z] tool: name=Read session=abc',
      '[2026-04-19T10:00:02.000Z] transcript parse: 12ms, partial=false, lines=100',
    ].join('\n') + '\n';
    writeFileSync(path, content);
    const h = getHookHealth({ logPath: path });
    assert.strictEqual(h.exists, true);
    assert.strictEqual(h.healthy, true);
    assert.strictEqual(h.errorCount, 0);
  }, 'd5-clean');
});

test('D5 getHookHealth: log with ERROR lines → healthy:false + recentErrors populated', async () => {
  await withTmp(async (tmp) => {
    const path = join(tmp, 'err.log');
    const content = [
      '[2026-04-19T10:00:00.000Z] mode=tool',
      '[2026-04-19T10:00:01.000Z] [ERROR] transcript parse error: ENOENT',
      '[2026-04-19T10:00:02.000Z] failed to POST',
    ].join('\n') + '\n';
    writeFileSync(path, content);
    const h = getHookHealth({ logPath: path });
    assert.strictEqual(h.exists, true);
    assert.strictEqual(h.healthy, false);
    assert.ok(h.errorCount >= 2);
    assert.ok(h.recentErrors.some((l) => l.includes('ERROR')));
  }, 'd5-err');
});

test('D5 getHookHealth: parses transcript P95 latency from log', async () => {
  await withTmp(async (tmp) => {
    const path = join(tmp, 'lat.log');
    const lines = [];
    for (let i = 1; i <= 20; i++) {
      lines.push(`[2026-04-19T10:00:0${i}.000Z] transcript parse: ${i}ms, partial=false, lines=5`);
    }
    writeFileSync(path, lines.join('\n') + '\n');
    const h = getHookHealth({ logPath: path });
    assert.strictEqual(h.transcriptSamples, 20);
    // P95 of 1..20 at floor(20*0.95) = 19 → sorted[19] = 20
    assert.ok(h.transcriptP95Ms >= 19, `expected P95 >= 19, got ${h.transcriptP95Ms}`);
  }, 'd5-p95');
});

summary();

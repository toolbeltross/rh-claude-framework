/**
 * Unit tests for FailureStore: D1 error classification, D2 retry detection,
 * D3 prompt linkage, D4 top-cost ranking.
 */
import assert from 'assert';
import { join } from 'path';
import { test, summary } from '../helpers/test-harness.js';
import { withTmp } from '../helpers/tmp.js';
import { FailureStore, classifyError, hashToolInvocation } from '../../server/failure-store.js';

console.log('failure-store tests:\n');

function newStore(tmp) {
  const s = new FailureStore(join(tmp, 'fail.jsonl'));
  return s;
}

// --- D1: classifyError ---
test('D1 classifyError: ENOENT → not_found', () => {
  assert.strictEqual(classifyError('ENOENT: file missing', 'post_tool_use_failure'), 'not_found');
});

test('D1 classifyError: EACCES → permission', () => {
  assert.strictEqual(classifyError('EACCES: permission denied', 'post_tool_use_failure'), 'permission');
});

test('D1 classifyError: 256KB size hint → size_limit', () => {
  assert.strictEqual(classifyError('Response exceeds 256KB limit', 'post_tool_use_failure'), 'size_limit');
});

test('D1 classifyError: timeout → timeout', () => {
  assert.strictEqual(classifyError('Command timed out after 120000ms', 'post_tool_use_failure'), 'timeout');
});

test('D1 classifyError: eventType=subagent_orphaned overrides text', () => {
  assert.strictEqual(classifyError('anything', 'subagent_orphaned'), 'orphan');
});

test('D1 classifyError: eventType=validation_block → validation', () => {
  assert.strictEqual(classifyError('[BLOCK] cat', 'validation_block'), 'validation');
});

test('D1 classifyError: unknown error → other', () => {
  assert.strictEqual(classifyError('some weird error', 'post_tool_use_failure'), 'other');
});

test('D1 append: stamps errorClass on record', async () => {
  await withTmp(async (tmp) => {
    const s = newStore(tmp);
    const rec = s.append({ toolName: 'Read', eventType: 'post_tool_use_failure', error: 'ENOENT: no such file' });
    assert.strictEqual(rec.errorClass, 'not_found');
  }, 'd1-append');
});

test('D1 load: backfills errorClass on historical records missing the field', async () => {
  await withTmp(async (tmp) => {
    const { writeFileSync } = await import('fs');
    const path = join(tmp, 'fail.jsonl');
    // Pre-populate with a record missing errorClass
    writeFileSync(path, JSON.stringify({
      id: 'old-1', timestamp: Date.now(), toolName: 'Read', eventType: 'post_tool_use_failure', error: 'ENOENT',
    }) + '\n');
    const s = new FailureStore(path);
    s.load();
    assert.strictEqual(s.cache.length, 1);
    assert.strictEqual(s.cache[0].errorClass, 'not_found', 'load should backfill errorClass');
  }, 'd1-backfill');
});

// --- D2: retry detection ---
test('D2 hashToolInvocation: same tool + input → identical hash', () => {
  const a = hashToolInvocation('Read', { file_path: '/tmp/x' });
  const b = hashToolInvocation('Read', { file_path: '/tmp/x' });
  assert.strictEqual(a, b);
});

test('D2 hashToolInvocation: different input → different hash', () => {
  const a = hashToolInvocation('Read', { file_path: '/tmp/x' });
  const b = hashToolInvocation('Read', { file_path: '/tmp/y' });
  assert.notStrictEqual(a, b);
});

test('D2 append: second identical failure within 60s stamps retryOf + retrySequence=1', async () => {
  await withTmp(async (tmp) => {
    const s = newStore(tmp);
    const r1 = s.append({ sessionId: 's', toolName: 'Read', error: 'ENOENT', toolInput: { file_path: '/tmp/x' } });
    const r2 = s.append({ sessionId: 's', toolName: 'Read', error: 'ENOENT', toolInput: { file_path: '/tmp/x' } });
    assert.strictEqual(r1.retrySequence, 0);
    assert.strictEqual(r1.retryOf, null);
    assert.strictEqual(r2.retrySequence, 1);
    assert.strictEqual(r2.retryOf, r1.id);
  }, 'd2-first-retry');
});

test('D2 append: third identical failure → retrySequence=2', async () => {
  await withTmp(async (tmp) => {
    const s = newStore(tmp);
    s.append({ sessionId: 's', toolName: 'Read', error: 'ENOENT', toolInput: { file_path: '/tmp/x' } });
    s.append({ sessionId: 's', toolName: 'Read', error: 'ENOENT', toolInput: { file_path: '/tmp/x' } });
    const r3 = s.append({ sessionId: 's', toolName: 'Read', error: 'ENOENT', toolInput: { file_path: '/tmp/x' } });
    assert.strictEqual(r3.retrySequence, 2);
  }, 'd2-third-retry');
});

test('D2 append: different session does not chain into retry', async () => {
  await withTmp(async (tmp) => {
    const s = newStore(tmp);
    s.append({ sessionId: 's1', toolName: 'Read', error: 'ENOENT', toolInput: { file_path: '/tmp/x' } });
    const r = s.append({ sessionId: 's2', toolName: 'Read', error: 'ENOENT', toolInput: { file_path: '/tmp/x' } });
    assert.strictEqual(r.retrySequence, 0);
    assert.strictEqual(r.retryOf, null);
  }, 'd2-session-isolation');
});

test('D2 append: config_change does NOT count as retry chain', async () => {
  await withTmp(async (tmp) => {
    const s = newStore(tmp);
    const r1 = s.append({ sessionId: 's', toolName: 'Config', eventType: 'config_change', error: 'x', toolInput: {} });
    const r2 = s.append({ sessionId: 's', toolName: 'Config', eventType: 'config_change', error: 'x', toolInput: {} });
    assert.strictEqual(r1.retrySequence, 0);
    assert.strictEqual(r2.retrySequence, 0, 'config_change should be exempt from retry detection');
  }, 'd2-config-exempt');
});

// --- D3: prompt linkage ---
test('D3 append: promptId + promptSnippet carry through', async () => {
  await withTmp(async (tmp) => {
    const s = newStore(tmp);
    const rec = s.append({
      sessionId: 's',
      toolName: 'Read',
      error: 'ENOENT',
      promptId: 's::12345',
      promptSnippet: 'please read config',
    });
    assert.strictEqual(rec.promptId, 's::12345');
    assert.strictEqual(rec.promptSnippet, 'please read config');
  }, 'd3-prompt');
});

test('D3 append: promptSnippet truncated at 200 chars', async () => {
  await withTmp(async (tmp) => {
    const s = newStore(tmp);
    const long = 'x'.repeat(500);
    const rec = s.append({ sessionId: 's', toolName: 'Read', error: 'x', promptSnippet: long });
    assert.strictEqual(rec.promptSnippet.length, 200);
  }, 'd3-trunc');
});

// --- D4: top-cost ranking ---
test('D4 getTopCostFailures: returns sorted descending by estimatedCost', async () => {
  await withTmp(async (tmp) => {
    const s = newStore(tmp);
    s.append({ sessionId: 's', toolName: 'Read', error: 'x', estimatedCost: 0.01 });
    s.append({ sessionId: 's', toolName: 'Read', error: 'x', estimatedCost: 0.50 });
    s.append({ sessionId: 's', toolName: 'Read', error: 'x', estimatedCost: 0.05 });
    const top = s.getTopCostFailures(2);
    assert.strictEqual(top.length, 2);
    assert.strictEqual(top[0].estimatedCost, 0.50);
    assert.strictEqual(top[1].estimatedCost, 0.05);
  }, 'd4-top');
});

test('D4 getTopCostFailures: excludes records without estimatedCost', async () => {
  await withTmp(async (tmp) => {
    const s = newStore(tmp);
    s.append({ sessionId: 's', toolName: 'Read', error: 'x' }); // no cost
    s.append({ sessionId: 's', toolName: 'Read', error: 'x', estimatedCost: 0.1 });
    const top = s.getTopCostFailures(5);
    assert.strictEqual(top.length, 1);
    assert.strictEqual(top[0].estimatedCost, 0.1);
  }, 'd4-filter');
});

// --- D getPatterns includes byClass + totalRetries ---
test('D getPatterns: includes byClass breakdown and totalRetries count', async () => {
  await withTmp(async (tmp) => {
    const s = newStore(tmp);
    s.append({ sessionId: 's', toolName: 'Read', error: 'ENOENT', toolInput: { file_path: '/a' } });
    s.append({ sessionId: 's', toolName: 'Read', error: 'ENOENT', toolInput: { file_path: '/a' } }); // retry
    s.append({ sessionId: 's', toolName: 'Bash', error: 'EACCES', toolInput: { command: 'rm' } });
    const p = s.getPatterns();
    assert.ok(p.byClass.not_found >= 2);
    assert.ok(p.byClass.permission >= 1);
    assert.strictEqual(p.totalRetries, 1);
  }, 'd-patterns');
});

summary();

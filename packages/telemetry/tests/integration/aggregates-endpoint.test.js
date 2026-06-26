/**
 * Integration test: spawn the real server with HOME=<tmp>, seed transcripts
 * under <tmp>/.claude/projects/, hit GET /api/aggregates, assert counts.
 *
 * Verifies the boot-time aggregator + endpoint wiring end-to-end.
 */
import assert from 'assert';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { test, summary } from '../helpers/test-harness.js';
import { withTmp } from '../helpers/tmp.js';
import { startTestServer, getJson } from '../helpers/server.js';

console.log('aggregates-endpoint integration tests:\n');

function seedTranscript(home, projName, sessionId, lines) {
  const projDir = join(home, '.claude', 'projects', projName);
  mkdirSync(projDir, { recursive: true });
  writeFileSync(join(projDir, `${sessionId}.jsonl`), lines.join('\n') + '\n');
}

function assistantLine(ts, sessionId, model, tokens) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    sessionId,
    cwd: '/test',
    message: {
      role: 'assistant',
      model,
      usage: {
        input_tokens: tokens.input || 0,
        output_tokens: tokens.output || 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      content: [{ type: 'text', text: 'hi' }],
    },
  });
}

test('GET /api/aggregates returns live totals from seeded transcripts', async () => {
  await withTmp(async (tmp) => {
    // Seed a minimal settings.json so server startup doesn't choke
    mkdirSync(join(tmp, '.claude'), { recursive: true });
    writeFileSync(join(tmp, '.claude', 'settings.json'), JSON.stringify({}));

    // Seed three transcripts across two project dirs, three days, three models
    seedTranscript(tmp, 'proj-a', 's1', [
      assistantLine('2026-05-17T08:00:00Z', 's1', 'claude-sonnet-4-6', { input: 1_000_000 }),
    ]);
    seedTranscript(tmp, 'proj-a', 's2', [
      assistantLine('2026-05-18T12:00:00Z', 's2', 'claude-haiku-4-5', { input: 1_000_000 }),
    ]);
    seedTranscript(tmp, 'proj-b', 's3', [
      assistantLine('2026-05-19T20:00:00Z', 's3', 'claude-opus-4-7', { input: 1_000_000 }),
    ]);

    const server = await startTestServer({ tmpHome: tmp });
    try {
      // Give the boot-time aggregator a moment to finish its async loadAll
      await new Promise((r) => setTimeout(r, 500));

      const agg = await getJson(`${server.baseUrl}/api/aggregates`);

      assert.strictEqual(agg.totalSessions, 3, 'sees 3 sessions');
      assert.strictEqual(agg.totalMessages, 3, '3 assistant messages');
      assert.strictEqual(agg.firstSessionDate, '2026-05-17T08:00:00Z');
      assert.strictEqual(agg.dailyActivity.length, 3, 'three distinct days');
      // Cost: $3 + $0.80 + $15 = $18.80
      assert.ok(Math.abs(agg.totalCost - 18.8) < 0.01, `expected ~18.80, got ${agg.totalCost}`);
      assert.ok(agg.modelUsage['claude-sonnet-4-6']);
      assert.ok(agg.modelUsage['claude-haiku-4-5']);
      assert.ok(agg.modelUsage['claude-opus-4-7']);
      assert.ok(typeof agg.lastComputedAt === 'number', 'lastComputedAt set');
    } finally {
      await server.stop();
    }
  }, 'aggr-int');
});

test('GET /api/aggregates with no transcripts returns empty aggregates', async () => {
  await withTmp(async (tmp) => {
    mkdirSync(join(tmp, '.claude'), { recursive: true });
    writeFileSync(join(tmp, '.claude', 'settings.json'), JSON.stringify({}));
    // Note: no projects/ directory at all

    const server = await startTestServer({ tmpHome: tmp });
    try {
      await new Promise((r) => setTimeout(r, 300));
      const agg = await getJson(`${server.baseUrl}/api/aggregates`);
      assert.strictEqual(agg.totalSessions, 0);
      assert.strictEqual(agg.totalMessages, 0);
      assert.strictEqual(agg.firstSessionDate, null);
      assert.deepStrictEqual(agg.dailyActivity, []);
    } finally {
      await server.stop();
    }
  }, 'aggr-int-empty');
});

summary();

/**
 * Integration tests for server/trends-router.js — P3-2.
 *
 * Spawns a real server in a tmp HOME, seeds a synthetic oversight-events.jsonl
 * and supervisory-log.md, fires real HTTP GETs to /api/trends, and asserts
 * the aggregation shape.
 */
import assert from 'assert';
import { mkdirSync, writeFileSync, copyFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { test, summary } from '../helpers/test-harness.js';
import { withTmp } from '../helpers/tmp.js';
import { startTestServer, getJson } from '../helpers/server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'fixtures');

console.log('trends-router integration tests:\n');

async function withSeededServer(seedFn, fn) {
  await withTmp(async (home) => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    copyFileSync(join(FIXTURES, 'settings/healthy.json'), join(home, '.claude', 'settings.json'));
    seedFn(home);
    // Clear OVERSIGHT_LOG_PATH so the subprocess falls through to
    // <tmp HOME>/.claude/oversight/supervisory-log.md. The developer's real
    // env often has this set pointing at the live oversight log, which
    // would otherwise contaminate the test.
    const srv = await startTestServer({
      tmpHome: home,
      extraEnv: { OVERSIGHT_LOG_PATH: '' },
    });
    try { await fn(srv, home); }
    finally { await srv.stop(); }
  }, 'trends-test');
}

function jsonlEvent(ts, type, data = {}) {
  return JSON.stringify({ timestamp: ts, event_type: type, data, content_hash: 'h' });
}
function isoMinus(days) {
  return new Date(Date.now() - days * 86400000).toISOString();
}

await test('GET /api/trends returns an aggregated snapshot with current+prior+sources', async () => {
  await withSeededServer(
    (home) => {
      const events = [
        jsonlEvent(isoMinus(1), 'oversight_auto_inject', { session_id: 'sA', missing_elements: ['verificationToken'] }),
        jsonlEvent(isoMinus(2), 'oversight_auto_inject', { session_id: 'sA', missing_elements: ['contextReport'] }),
        jsonlEvent(isoMinus(3), 'instructions_loaded',   { session_id: 'sB' }),
        jsonlEvent(isoMinus(10), 'instructions_loaded',  { session_id: 'sC' }), // prior window
      ];
      writeFileSync(join(home, '.claude', 'oversight-events.jsonl'), events.join('\n'));
    },
    async (srv) => {
      const r = await getJson(`${srv.baseUrl}/api/trends?days=7`);
      assert.strictEqual(r.days, 7);
      assert.strictEqual(r.current.total, 3, `current.total expected 3, got ${r.current.total}`);
      assert.strictEqual(r.prior.total, 1, `prior.total expected 1, got ${r.prior.total}`);
      assert.ok(Array.isArray(r.current.byType));
      assert.ok(Array.isArray(r.current.byDay));
      assert.ok(r.sources?.events?.path, 'sources.events.path present');
      // Top event type
      assert.strictEqual(r.current.byType[0][0], 'oversight_auto_inject');
      assert.strictEqual(r.current.byType[0][1], 2);
      // Missing elements aggregated
      const mNames = r.current.missingElements.map(([k]) => k);
      assert.ok(mNames.includes('verificationToken'), 'verificationToken in missingElements');
      assert.ok(mNames.includes('contextReport'), 'contextReport in missingElements');
    }
  );
});

await test('GET /api/trends?days=N respects custom window', async () => {
  await withSeededServer(
    (home) => {
      const events = [
        jsonlEvent(isoMinus(1), 'X', { session_id: 's1' }),
        jsonlEvent(isoMinus(20), 'X', { session_id: 's2' }), // outside 14d window
      ];
      writeFileSync(join(home, '.claude', 'oversight-events.jsonl'), events.join('\n'));
    },
    async (srv) => {
      const r = await getJson(`${srv.baseUrl}/api/trends?days=14`);
      assert.strictEqual(r.days, 14);
      assert.strictEqual(r.current.total, 1, 'only the 1d-old event falls in 14d window');
    }
  );
});

await test('GET /api/trends with missing events file returns total:0 + fileMissing flag', async () => {
  await withSeededServer(
    (_home) => { /* no events file seeded */ },
    async (srv) => {
      const r = await getJson(`${srv.baseUrl}/api/trends?days=7`);
      assert.strictEqual(r.current.total, 0);
      assert.strictEqual(r.sources.events.fileMissing, true, 'fileMissing flag surfaces');
    }
  );
});

await test('GET /api/trends?days=invalid falls back to default 7', async () => {
  await withSeededServer(
    (home) => {
      writeFileSync(join(home, '.claude', 'oversight-events.jsonl'),
        jsonlEvent(isoMinus(1), 'X', { session_id: 's' }));
    },
    async (srv) => {
      const r = await getJson(`${srv.baseUrl}/api/trends?days=not-a-number`);
      assert.strictEqual(r.days, 7);
    }
  );
});

await test('GET /api/trends caps days at 90 to prevent runaway scans', async () => {
  await withSeededServer(
    (home) => {
      writeFileSync(join(home, '.claude', 'oversight-events.jsonl'),
        jsonlEvent(isoMinus(1), 'X', { session_id: 's' }));
    },
    async (srv) => {
      const r = await getJson(`${srv.baseUrl}/api/trends?days=9999`);
      assert.strictEqual(r.days, 90, 'days clamped to 90');
    }
  );
});

await test('GET /api/trends surfaces Layer3a rejections from supervisory log', async () => {
  await withSeededServer(
    (home) => {
      writeFileSync(join(home, '.claude', 'oversight-events.jsonl'), '');
      const oversightDir = join(home, '.claude', 'oversight');
      mkdirSync(oversightDir, { recursive: true });
      const ts = new Date(Date.now() - 2 * 86400000).toISOString().replace('T', ' ').replace(/\..*$/, '');
      writeFileSync(join(oversightDir, 'supervisory-log.md'),
        `# Supervisory log\n- **${ts}** | \`hot-sess\` | Layer3a-rejection | Rule 3 violation\n`);
    },
    async (srv) => {
      const r = await getJson(`${srv.baseUrl}/api/trends?days=7`);
      assert.strictEqual(r.current.layer3aRejections, 1, 'rejection counted');
      const sids = r.current.rejectBySid.map(([s]) => s);
      assert.ok(sids.includes('hot-sess'), 'hot-sess surfaced in rejectBySid');
    }
  );
});

summary();

/**
 * Integration tests for server/statusline-watcher.js — verify chokidar
 * picks up settings.json changes and updates store.statusLineState.
 */
import assert from 'assert';
import { mkdirSync, copyFileSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { test, summary } from '../helpers/test-harness.js';
import { withTmp } from '../helpers/tmp.js';
import { startTestServer, getJson } from '../helpers/server.js';
import { openTestWs } from '../helpers/ws-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '..', 'fixtures');

console.log('statusline-watcher integration tests:\n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('boot classification reads tmp HOME settings.json on startup', async () => {
  await withTmp(async (home) => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    copyFileSync(join(FIXTURES, 'settings/healthy.json'), join(home, '.claude', 'settings.json'));
    const srv = await startTestServer({ tmpHome: home });
    try {
      const snap = await getJson(srv.baseUrl + '/api/snapshot');
      // Healthy fixture command contains hook-forwarder.js status — should classify telemetry
      assert.strictEqual(snap.statusLineState.class, 'telemetry');
    } finally {
      await srv.stop();
    }
  }, 'boot');
});

test('boot classification handles missing statusLine', async () => {
  await withTmp(async (home) => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    copyFileSync(join(FIXTURES, 'settings/missing.json'), join(home, '.claude', 'settings.json'));
    const srv = await startTestServer({ tmpHome: home });
    try {
      const snap = await getJson(srv.baseUrl + '/api/snapshot');
      assert.strictEqual(snap.statusLineState.class, 'missing');
    } finally {
      await srv.stop();
    }
  }, 'boot-missing');
});

test('file watcher reclassifies after settings.json rewrite', async () => {
  await withTmp(async (home) => {
    const settingsPath = join(home, '.claude', 'settings.json');
    mkdirSync(join(home, '.claude'), { recursive: true });
    copyFileSync(join(FIXTURES, 'settings/healthy.json'), settingsPath);
    const srv = await startTestServer({ tmpHome: home });
    try {
      let snap = await getJson(srv.baseUrl + '/api/snapshot');
      assert.strictEqual(snap.statusLineState.class, 'telemetry');

      // Rewrite to unknown-custom
      writeFileSync(settingsPath, readFileSync(join(FIXTURES, 'settings/unknown-custom.json'), 'utf-8'));

      // Watcher poll interval is 1000ms — give it some headroom
      let reclassified = false;
      for (let i = 0; i < 20; i++) {
        await sleep(300);
        snap = await getJson(srv.baseUrl + '/api/snapshot');
        if (snap.statusLineState.class === 'unknown-custom') {
          reclassified = true;
          break;
        }
      }
      assert.ok(reclassified, `expected unknown-custom, got ${snap.statusLineState.class}`);
    } finally {
      await srv.stop();
    }
  }, 'watcher-reclassify');
});

test('file watcher broadcasts statusLineState frame on class change', async () => {
  await withTmp(async (home) => {
    const settingsPath = join(home, '.claude', 'settings.json');
    mkdirSync(join(home, '.claude'), { recursive: true });
    copyFileSync(join(FIXTURES, 'settings/healthy.json'), settingsPath);
    const srv = await startTestServer({ tmpHome: home });
    let ws;
    try {
      ws = await openTestWs(srv.wsUrl);
      await ws.waitFor((f) => f.type === 'snapshot');

      // Rewrite to unknown-custom — should fire one statusLineState frame
      writeFileSync(settingsPath, readFileSync(join(FIXTURES, 'settings/unknown-custom.json'), 'utf-8'));

      const frame = await ws.waitFor(
        (f) => f.type === 'statusLineState' && f.data?.class === 'unknown-custom',
        7000
      );
      assert.strictEqual(frame.data.class, 'unknown-custom');
    } finally {
      if (ws) await ws.close();
      await srv.stop();
    }
  }, 'watcher-broadcast');
});

summary();

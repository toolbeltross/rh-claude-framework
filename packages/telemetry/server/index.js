import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { store } from './store.js';
import { startWatchers } from './watchers.js';
import { startBroadcaster } from './broadcaster.js';
import { startPlanDetector } from './plan-detector.js';
import { startStatusLineWatcher } from './statusline-watcher.js';
import hookReceiver from './hook-receiver.js';

import { PORT, VITE_DEV_PORT } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const server = createServer(app);

// Middleware
app.use(cors());
app.use(express.json());

// API routes
app.use('/api', hookReceiver);

app.get('/api/snapshot', (_req, res) => {
  res.json(store.getSnapshot());
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.post('/api/refresh', (_req, res) => {
  const result = store.forceRefresh();
  res.json({ status: 'ok', ...result });
});

// Test-only debug endpoint — gated behind RH_TELEMETRY_TEST_MODE=1.
// Allows browser tests to push synthetic state into the store without
// going through the public hook surface. NEVER mounted in production.
if (process.env.RH_TELEMETRY_TEST_MODE === '1') {
  app.post('/api/_test/state', (req, res) => {
    try {
      const { method, args } = req.body || {};
      if (typeof method !== 'string' || !Array.isArray(args)) {
        return res.status(400).json({ error: 'expected { method, args }' });
      }
      const fn = store[method];
      if (typeof fn !== 'function') {
        return res.status(404).json({ error: `store.${method} is not a function` });
      }
      const result = fn.apply(store, args);
      res.json({ ok: true, result: result === undefined ? null : result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  console.log('[test-mode] /api/_test/state endpoint mounted');
}

// Serve built frontend in production
const distPath = join(__dirname, '..', 'dist');
if (existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('*', (_req, res) => {
    res.sendFile(join(distPath, 'index.html'));
  });
}

// Start everything
store.failureStore.load();
store.hookPerfStore.load();
startWatchers();
startBroadcaster(server);
startPlanDetector(store);
startStatusLineWatcher();

// Prune stale live sessions every 5 minutes (manual refresh button handles immediate cleanup)
setInterval(() => store.pruneStale(), 5 * 60_000);

server.listen(PORT, () => {
  console.log(`\n  Claude Code Telemetry Server`);
  console.log(`  API:       http://localhost:${PORT}/api/snapshot`);
  console.log(`  WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`  Dashboard: http://localhost:${VITE_DEV_PORT} (dev) or http://localhost:${PORT} (prod)\n`);
});
import express from 'express';
import cors from 'cors';
import chokidar from 'chokidar';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join, basename } from 'path';
import { existsSync } from 'fs';
import { store } from './store.js';
import { startWatchers } from './watchers.js';
import { startBroadcaster } from './broadcaster.js';
import { startPlanDetector } from './plan-detector.js';
import { startStatusLineWatcher } from './statusline-watcher.js';
import hookReceiver from './hook-receiver.js';
import trendsRouter from './trends-router.js';
import { aggregatesStore } from './aggregates-store.js';

import {
  PORT,
  VITE_DEV_PORT,
  CLAUDE_PROJECTS_DIR,
  FILE_POLL_INTERVAL_MS,
  WRITE_STABILITY_MS,
  WRITE_POLL_MS,
} from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const server = createServer(app);

// Middleware
app.use(cors());
app.use(express.json());

// API routes
app.use('/api', hookReceiver);
app.use(trendsRouter);

app.get('/api/snapshot', (_req, res) => {
  res.json(store.getSnapshot());
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Live transcript aggregates (replaces dependence on stats-cache.json).
// Output shape matches parser.js:parseStatsCache + lastComputedAt timestamp.
app.get('/api/aggregates', (_req, res) => {
  res.json(aggregatesStore.getAggregates());
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
// RH_TELEMETRY_UI=v1 (default) → serve dist/   ;  RH_TELEMETRY_UI=v2 → serve dist-v2/
// If the chosen build is missing, log a warning and skip the static mount
// (do NOT silently fall back — would mask "did my build run?").
const RH_TELEMETRY_UI = process.env.RH_TELEMETRY_UI === 'v2' ? 'v2' : 'v1';
const distDirName = RH_TELEMETRY_UI === 'v2' ? 'dist-v2' : 'dist';
const distPath = join(__dirname, '..', distDirName);
const distEntryHtml = RH_TELEMETRY_UI === 'v2' ? 'index.v2.html' : 'index.html';
if (existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('*', (_req, res) => {
    res.sendFile(join(distPath, distEntryHtml));
  });
  console.log(`[server] UI=${RH_TELEMETRY_UI}, serving ${distPath}`);
} else {
  console.warn(`[server] UI=${RH_TELEMETRY_UI} requested but ${distPath} does not exist — static mount skipped. Run \`npm run build${RH_TELEMETRY_UI === 'v2' ? ':v2' : ''}\` to build it.`);
}

// Start everything
store.failureStore.load();
store.hookPerfStore.load();
startWatchers();
startBroadcaster(server);
startPlanDetector(store);
startStatusLineWatcher();

// Live transcript aggregator: walk ~/.claude/projects/ on boot, then watch
// for incremental updates. Replaces the stale stats-cache.json dependency
// for v2 (and any v1 surface that opts in).
aggregatesStore.loadAll().catch((err) => {
  console.error('[aggregates] initial load failed:', err.message);
});

if (existsSync(CLAUDE_PROJECTS_DIR)) {
  const projectsWatcher = chokidar.watch(`${CLAUDE_PROJECTS_DIR.replace(/\\/g, '/')}/**/*.jsonl`, {
    usePolling: true,
    interval: FILE_POLL_INTERVAL_MS,
    awaitWriteFinish: {
      stabilityThreshold: WRITE_STABILITY_MS,
      pollInterval: WRITE_POLL_MS,
    },
    ignoreInitial: true, // initial load handled by loadAll()
  });

  const handleEvent = (path) => {
    const sessionId = basename(path).replace(/\.jsonl$/, '');
    aggregatesStore.reloadSession(sessionId, path).catch((err) => {
      console.warn(`[aggregates] reloadSession(${sessionId}) failed: ${err.message}`);
    });
  };

  projectsWatcher.on('add', handleEvent);
  projectsWatcher.on('change', handleEvent);
  projectsWatcher.on('unlink', (path) => {
    const sessionId = basename(path).replace(/\.jsonl$/, '');
    aggregatesStore.removeSession(sessionId);
  });

  console.log(`[aggregates] watching ${CLAUDE_PROJECTS_DIR}`);
} else {
  console.warn(`[aggregates] ${CLAUDE_PROJECTS_DIR} does not exist — aggregator will be empty`);
}

// Prune stale live sessions every 5 minutes (manual refresh button handles immediate cleanup)
setInterval(() => store.pruneStale(), 5 * 60_000);

server.listen(PORT, () => {
  console.log(`\n  Claude Code Telemetry Server`);
  console.log(`  API:       http://localhost:${PORT}/api/snapshot`);
  console.log(`  WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`  Dashboard: http://localhost:${VITE_DEV_PORT} (dev) or http://localhost:${PORT} (prod)\n`);
});
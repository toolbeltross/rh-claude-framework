import express from 'express';
import cors from 'cors';
import chokidar from 'chokidar';
import { createServer } from 'http';
import { spawnSync } from 'child_process';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join, basename } from 'path';
import { existsSync } from 'fs';
import { store } from './store.js';
import { startWatchers } from './watchers.js';
import { startBroadcaster, broadcastFrame } from './broadcaster.js';
import { startPlanDetector } from './plan-detector.js';
import { startStatusLineWatcher } from './statusline-watcher.js';
import hookReceiver from './hook-receiver.js';
import trendsRouter from './trends-router.js';
import { aggregatesStore, decomposeSubagentPath } from './aggregates-store.js';
import { readOversightEvents, startOversightWatcher } from './oversight-bridge.js';
import { getCcdSessionTitles } from './ccd-sessions.js';

import {
  PORT,
  HOST,
  VITE_DEV_PORT,
  CLAUDE_PROJECTS_DIR,
  JSONL_POLL_INTERVAL_MS,
  JSONL_STABILITY_MS,
  JSONL_WRITE_POLL_MS,
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

// Per-session detail list (Sessions surface). Same aggregator, un-rolled.
app.get('/api/sessions', (_req, res) => {
  res.json(aggregatesStore.getSessions());
});

// Single-session drill-through: deep transcript parse + this session's
// subagent runs. 404 when the transcript is gone (pruned by Claude Code).
app.get('/api/sessions/:id', async (req, res) => {
  try {
    const detail = await aggregatesStore.getSessionDetail(req.params.id);
    if (!detail) return res.status(404).json({ error: 'session not found on disk' });
    res.json(detail);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cross-session subagent list + per-type leaderboard (Subagents surface).
app.get('/api/subagents', (_req, res) => {
  res.json(aggregatesStore.getSubagents());
});

// Single-agent drill-through: record + tool histogram from the agent transcript.
app.get('/api/subagents/:id', async (req, res) => {
  try {
    const detail = await aggregatesStore.getSubagentDetail(req.params.id);
    if (!detail) return res.status(404).json({ error: 'agent transcript not found on disk' });
    res.json(detail);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Claude Code Desktop session titles, keyed by transcript session id.
// Empty map on machines without the Desktop app — clients must fall back.
app.get('/api/ccd-sessions', async (_req, res) => {
  try {
    res.json({ byCliId: await getCcdSessionTitles() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Oversight events feed — ~/.claude/oversight-events.jsonl read through
// the bridge façade. Lightweight always-on view; deeper aggregation goes
// through /api/trends which wraps @rh/oversight rh-supervisor-sweep.
app.get('/api/oversight/events', async (req, res) => {
  const days = Math.max(1, Math.min(90, parseInt(req.query.days || '7', 10)));
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
  try {
    const data = await readOversightEvents({ sinceMs, recentLimit: 100 });
    res.json({ ...data, days });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/refresh', (_req, res) => {
  const result = store.forceRefresh();
  res.json({ status: 'ok', ...result });
});

// ── Scribe backlog disposition (PLAN-2026-06-15, closes F-K) ─────────────────
// The dashboard is otherwise read-only; these are the first UI write actions
// (the /api/refresh precedent). md files stay canonical — both endpoints
// delegate to the DEPLOYED CJS scripts under ~/.claude/scripts/ (location-
// independent of this monorepo; same scripts the hooks run), which own config
// resolution, the file-lock, the strict parser, and the DB shadow.
const DEPLOYED_SCRIPTS = join(homedir(), '.claude', 'scripts');
const SCRIBE_PAGE = join(__dirname, 'public', 'scribe.html');

function runDeployed(scriptName, args) {
  const r = spawnSync('node', [join(DEPLOYED_SCRIPTS, scriptName), ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 15000,
  });
  let json = null;
  try { json = JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch { /* leave null */ }
  return { status: r.status, json, stderr: r.stderr || '', error: r.error };
}

// GET /api/scribe?status=open&bucket=cleanup — current backlog + proposal overlay.
app.get('/api/scribe', (req, res) => {
  const args = [];
  if (req.query.status === 'all') args.push('--all');
  else { args.push('--status', String(req.query.status || 'open')); }
  if (req.query.bucket) args.push('--bucket', String(req.query.bucket));
  const out = runDeployed('rh-scribe-query.js', args);
  if (!out.json) return res.status(500).json({ error: 'scribe-query failed', stderr: out.stderr.slice(0, 300) });
  res.json(out.json);
});

// POST /api/scribe/disposition { bucket, source_file, row_id, disposition, note?, duplicateOf? }
// disposition ∈ {resolve, stale, duplicate-of, still-open}  (C5: validated here).
const DISPOSITIONS = new Set(['resolve', 'stale', 'duplicate-of', 'still-open']);
app.post('/api/scribe/disposition', (req, res) => {
  const { source_file, row_id, disposition, note, duplicateOf } = req.body || {};
  if (!source_file || !row_id || !DISPOSITIONS.has(disposition)) {
    return res.status(400).json({ error: 'require source_file, row_id, and disposition ∈ {resolve, stale, duplicate-of, still-open}' });
  }
  const today = new Date().toISOString().slice(0, 10);
  const noteStr = note ? ` ${String(note).replace(/[|\n\r]/g, ' ').trim()}` : '';
  let status;
  switch (disposition) {
    case 'resolve':      status = `resolved:${noteStr || ' (via /scribe)'} (${today})`; break;
    case 'stale':        status = `stale:${noteStr} (${today})`; break;
    case 'duplicate-of': status = `resolved: duplicate-of ${String(duplicateOf || '?').replace(/[|\n\r]/g, '')}${noteStr} (${today})`; break;
    case 'still-open':   status = 'open'; break;
  }
  const out = runDeployed('rh-scribe-row-update.js', ['--source', String(source_file), '--id', String(row_id), '--status', status]);
  if (out.error || !out.json) {
    return res.status(500).json({ error: 'row-update spawn failed', stderr: out.stderr.slice(0, 300) });
  }
  if (!out.json.ok) return res.status(409).json({ ok: false, error: out.json.error });
  broadcastFrame('scribeDisposition', { row_id, disposition, status });
  res.json({ ok: true, row_id, disposition, status, oldStatus: out.json.oldStatus });
});

// GET /scribe — the disposition review page (registered before the SPA catch-all).
app.get('/scribe', (_req, res) => {
  if (existsSync(SCRIBE_PAGE)) return res.sendFile(SCRIBE_PAGE);
  res.status(404).send('scribe.html not found — run the build/deploy');
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
    interval: JSONL_POLL_INTERVAL_MS,
    // Append-only JSONL: parseTranscript skips a partially-written last
    // line, so a short stability window is safe and much fresher.
    awaitWriteFinish: {
      stabilityThreshold: JSONL_STABILITY_MS,
      pollInterval: JSONL_WRITE_POLL_MS,
    },
    ignoreInitial: true, // initial load handled by loadAll()
  });

  // Route subagent transcripts (<projDir>/<sessionId>/subagents/agent-*.jsonl)
  // to the subagent store. Before this branch existed, the recursive glob fed
  // them into reloadSession(), silently inflating session aggregates whenever
  // an active subagent wrote its transcript.
  const handleEvent = (path) => {
    const sub = decomposeSubagentPath(path);
    if (sub) {
      aggregatesStore.reloadSubagent(sub.agentId, path, sub.projectDir, sub.parentSessionId).catch((err) => {
        console.warn(`[aggregates] reloadSubagent(${sub.agentId}) failed: ${err.message}`);
      });
      return;
    }
    const sessionId = basename(path).replace(/\.jsonl$/, '');
    aggregatesStore.reloadSession(sessionId, path).catch((err) => {
      console.warn(`[aggregates] reloadSession(${sessionId}) failed: ${err.message}`);
    });
  };

  projectsWatcher.on('add', handleEvent);
  projectsWatcher.on('change', handleEvent);
  projectsWatcher.on('unlink', (path) => {
    const sub = decomposeSubagentPath(path);
    if (sub) {
      aggregatesStore.removeSubagent(sub.agentId);
      return;
    }
    const sessionId = basename(path).replace(/\.jsonl$/, '');
    aggregatesStore.removeSession(sessionId);
  });

  console.log(`[aggregates] watching ${CLAUDE_PROJECTS_DIR}`);
} else {
  console.warn(`[aggregates] ${CLAUDE_PROJECTS_DIR} does not exist — aggregator will be empty`);
}

// Real-time oversight push: watch ~/.claude/oversight-events.jsonl and push
// appended events to all WS clients. The Oversight surface keeps its 30s poll
// as fallback (ADDITIVE — both paths stay live per project rules).
startOversightWatcher((events) => {
  broadcastFrame('oversightEvent', { events });
});

// Prune stale live sessions every 5 minutes (manual refresh button handles immediate cleanup)
setInterval(() => store.pruneStale(), 5 * 60_000);

server.listen(PORT, HOST, () => {
  console.log(`\n  Claude Code Telemetry Server`);
  console.log(`  Bind:      ${HOST}:${PORT}${HOST === '127.0.0.1' ? ' (loopback — set RH_TELEMETRY_HOST=0.0.0.0 to expose on the LAN)' : ' (exposed beyond loopback)'}`);
  console.log(`  API:       http://localhost:${PORT}/api/snapshot`);
  console.log(`  WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`  Dashboard: http://localhost:${VITE_DEV_PORT} (dev) or http://localhost:${PORT} (prod)\n`);
});
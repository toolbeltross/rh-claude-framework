// server/trends-router.js
//
// P3-2: serves the supervisor-sweep aggregation as JSON for the Dashboard
// "Trends" tab. Cross-package require — the sweep module is the canonical
// implementation in packages/oversight/scripts/rh-supervisor-sweep.js;
// duplicating its aggregation here would rot.

import express from 'express';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Resolve the sweep module via the monorepo path. Two-package layout per
// rh-claude-framework CLAUDE.md is stable.
const SWEEP_PATH = join(__dirname, '..', '..', 'oversight', 'scripts', 'rh-supervisor-sweep.js');
let sweep = null;
try { sweep = require(SWEEP_PATH); }
catch (e) {
  console.warn('[trends-router] could not load sweep module from ' + SWEEP_PATH + ': ' + e.message);
}

const router = express.Router();

// Default paths. Computed per-request so a tmp-HOME spawned for tests sees
// the right paths and is not contaminated by the developer's real env vars
// (OVERSIGHT_LOG_PATH / OVERSIGHT_EVENTS_PATH frequently set in dev).
//
// Resolution order:
//   1. query string override (tests + ad-hoc CLI use)
//   2. <HOME>/.claude/oversight-events.jsonl  (the only place writers ever
//      put it; not env-overridden — env overrides on the writer side are
//      sufficient for production reconfig)
function resolveEventsPath(qs) {
  return qs || join(homedir(), '.claude', 'oversight-events.jsonl');
}
function resolveSupLogPath(qs) {
  return qs || process.env.OVERSIGHT_LOG_PATH || join(homedir(), '.claude', 'oversight', 'supervisory-log.md');
}

router.get('/api/trends', (req, res) => {
  if (!sweep) {
    return res.status(500).json({ error: 'sweep module not loaded' });
  }
  let days = parseInt(req.query.days, 10);
  if (!Number.isFinite(days) || days <= 0) days = 7;
  if (days > 90) days = 90;

  const eventsPath = resolveEventsPath(req.query.events);
  const supervisoryLogPath = resolveSupLogPath(req.query.supervisoryLog);

  const now = Date.now();
  const windowMs = days * 24 * 60 * 60 * 1000;
  const cur = sweep.readEvents(eventsPath, now - windowMs, now);
  const prior = sweep.readEvents(eventsPath, now - 2 * windowMs, now - windowMs);
  const curRej = sweep.readLayer3aRejections(supervisoryLogPath, now - windowMs, now);
  const priorRej = sweep.readLayer3aRejections(supervisoryLogPath, now - 2 * windowMs, now - windowMs);

  const current = sweep.aggregate(cur.events, curRej.rejections, now - windowMs, now);
  const priorAgg = sweep.aggregate(prior.events, priorRej.rejections, now - 2 * windowMs, now - windowMs);

  res.json({
    days,
    current,
    prior: priorAgg,
    sources: {
      events: { path: eventsPath, fileMissing: cur.fileMissing, parsedLines: cur.parsedLines },
      supervisoryLog: { path: supervisoryLogPath, fileMissing: curRej.fileMissing },
    },
  });
});

export default router;

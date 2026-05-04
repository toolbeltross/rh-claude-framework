#!/usr/bin/env node
// rh-learning-loop.js — daily aggregation of oversight events into
// supervisor-curated proposals on Workspace/recommendations.md.
//
// Phase 4 D2 (2026-05-02). Triggered by rh-daily-regen.js as the final
// step of the daily pipeline.
//
// Driver responsibilities (this script): read events, group, threshold-filter,
// DEDUP against existing open proposals (Option B), dispatch supervisor with
// scope=learning-loop. The supervisor itself owns proposal-text drafting and
// appending to recommendations.md (via lib/file-lock.js withLock — see
// rh-supervisor.md "Learning Loop Mode" section).
//
// Manual triage gate: every proposal lands as status=open. Nothing auto-applies.
//
// Hard dependency: lib/file-lock.js (Phase 1 C1) — supervisor uses it to write.
//
// Cadence: daily (changed from weekly 2026-05-02). Same-day guard (20h) prevents
// double-dispatch from overlapping triggers (e.g., daily-regen runs twice in a
// short window). Once a (event_type, group_key) appears as an open proposal in
// recommendations.md, subsequent runs SKIP that group regardless of recency —
// this is Option B dedup (see PLAN-oversight-improvements). When the user marks
// a proposal `resolved` or `stale`, the next daily run will start re-proposing
// any new occurrences (since the dedup-skip filter only matches `open` rows).
//
// Cost: Sonnet on ~5 groups, ~5KB total prompt ≈ $0.05–$0.15/run × ~30 fires/yr
// (most days have no new threshold-crossing groups) ≈ $5–$15/yr after dedup.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { withPhase } = require(path.join(__dirname, 'lib', 'phase-timing'));
const { config } = require('./lib/config');

const EVENTS_PATH = process.env.OVERSIGHT_EVENTS_PATH ||
  path.join(config.claudeDir, 'oversight-events.jsonl');
const RECS_PATH = process.env.RECOMMENDATIONS_PATH ||
  path.join(config.home, 'OneDrive', 'Workspace', 'recommendations.md');
const LOOKBACK_DAYS = parseInt(process.env.LOOKBACK_DAYS, 10) || 7;
const LAST_RUN_FILE = path.join(config.claudeDir, 'learning-loop-last-run.txt');
// 20h same-day guard (was 6 days when cadence was weekly). At daily cadence,
// the guard prevents double-dispatch from overlapping triggers within ~1 day
// while still allowing the next day's natural fire to proceed.
const SAME_DAY_GUARD_HOURS = 20;

// Threshold table — keep in sync with rh-supervisor.md learning-loop section.
const THRESHOLDS = {
  layer3a_rejection:        { min: 3, requireMultiSession: false },
  oversight_auto_inject:    { min: 5, requireMultiSession: true  },
  consolidation_blocked:    { min: 3, requireMultiSession: false },
  subagent_failure_detected:{ min: 3, requireMultiSession: false },
};

function readEventsSince(cutoffMs) {
  if (!fs.existsSync(EVENTS_PATH)) return [];
  return fs.readFileSync(EVENTS_PATH, 'utf8')
    .split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(e => e && e.timestamp && Date.parse(e.timestamp) >= cutoffMs);
}

function groupKey(ev) {
  const d = ev.data || {};
  if (ev.event_type === 'oversight_auto_inject') {
    const tuple = (d.missing_elements || []).slice().sort().join('+');
    return `${d.subagent_type || '∅'}::${tuple}`;
  }
  if (ev.event_type === 'layer3a_rejection') {
    const m = /Rule\s*(\d)/i.exec(d.reason || '');
    return `rule${m ? m[1] : '?'}::${(d.reason || '').slice(0, 60)}`;
  }
  return JSON.stringify(d).slice(0, 80);
}

function buildGroups(events) {
  const buckets = new Map();
  for (const e of events) {
    const k = `${e.event_type}|${groupKey(e)}`;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(e);
  }
  const groups = [];
  for (const [k, evs] of buckets) {
    const event_type = k.split('|', 1)[0];
    const cfg = THRESHOLDS[event_type];
    if (!cfg) continue;
    const sessions = new Set(evs.map(e => (e.data && e.data.session_id) || '').filter(Boolean));
    if (evs.length < cfg.min) continue;
    if (cfg.requireMultiSession && sessions.size < 2) continue;
    groups.push({
      event_type,
      group_key: k.slice(event_type.length + 1),
      count: evs.length,
      distinct_sessions: sessions.size,
      first_seen: evs[0].timestamp,
      last_seen:  evs[evs.length - 1].timestamp,
      sample_events: evs.slice(0, 5),
    });
  }
  return groups.sort((a, b) => b.count - a.count);
}

function checkSameDayGuard() {
  if (!fs.existsSync(LAST_RUN_FILE)) return { skip: false };
  try {
    const stat = fs.statSync(LAST_RUN_FILE);
    const ageMs = Date.now() - stat.mtimeMs;
    const ageHours = ageMs / (3600 * 1000);
    if (ageHours < SAME_DAY_GUARD_HOURS) {
      return { skip: true, ageHours: ageHours.toFixed(1) };
    }
  } catch {}
  return { skip: false };
}

// Option B dedup: read existing open `session=learning-loop` rows from
// recommendations.md and extract the (event_type, group_key) fingerprints.
// Groups already represented by an open proposal are skipped — no re-dispatch.
//
// Fingerprint format the supervisor MUST embed in the row text (per D1
// contract in rh-supervisor.md): `event_type=<X> group_key=<Y>`. We parse
// those tokens from the text field of each open `session=learning-loop`
// pipe-table row.
function readOpenProposedFingerprints(recsPath) {
  if (!fs.existsSync(recsPath)) return new Set();
  const content = fs.readFileSync(recsPath, 'utf8');
  const fingerprints = new Set();
  for (const line of content.split(/\r?\n/)) {
    if (!line.startsWith('|')) continue;
    if (line.startsWith('|---') || line.startsWith('| id ')) continue;
    if (line.includes('<!-- scribe-done -->')) continue;
    // Split on unescaped pipes and unescape \| → |
    const cells = line.split(/(?<!\\)\|/).map(c => c.replace(/\\\|/g, '|').trim()).slice(1, -1);
    if (cells.length < 5) continue;
    const [, , session, text, status] = cells;
    if (session !== 'learning-loop' || status !== 'open') continue;
    const etMatch = /event_type=([\S]+)/.exec(text);
    const gkMatch = /group_key=([\S]+)/.exec(text);
    if (etMatch && gkMatch) {
      fingerprints.add(etMatch[1] + '|' + gkMatch[1]);
    }
  }
  return fingerprints;
}

function recordRun() {
  try { fs.writeFileSync(LAST_RUN_FILE, new Date().toISOString() + '\n'); } catch {}
}

function dispatchSupervisor(groups) {
  // Build prompt; embed REQUIRED oversight-block elements verbatim so
  // rh-agent-oversight-guard.js does NOT auto-inject (saves a round-trip
  // and prevents the next weekly run from learning about itself).
  // The three regex checks in agent-oversight-guard.js are:
  //   /verification token|literal first line|first line verbatim/i
  //   /compaction/i AND /% used/i
  //   /batch overflow|STOP and return|stop.*remaining count/i
  const prompt = [
    'scope=learning-loop',
    `events_path=${EVENTS_PATH}`,
    `lookback_days=${LOOKBACK_DAYS}`,
    `recommendations_path=${RECS_PATH}`,
    `groups=${JSON.stringify(groups)}`,
    '',
    'Verification token: when proposing a rule wording change, return the literal first line of the target rule file as proof you read it.',
    'Self-reported telemetry: end with #compactions and % of context window used.',
    'Batch overflow rule: if groups exceed your processing capacity, STOP and return remaining count rather than processing partial.',
    '',
    'Honor the Learning Loop Mode contract in your agent definition.',
  ].join('\n');

  // Spawn cwd: config.home, NOT OneDrive workspace path. OneDrive cwd produces ENOENT
  // pointing at the executable when OneDrive sync is off (documented in
  // ~/.claude/memory-shared/learnings/windows-spawn-enoent-cwd.md).
  const r = spawnSync('claude', ['-p', '--agent', 'rh-supervisor', prompt], {
    encoding: 'utf8',
    timeout: 5 * 60 * 1000,
    cwd: config.home,
  });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}

function warnIfPrimarySignalEmpty(events) {
  const layer3aCount = events.filter(e => e.event_type === 'layer3a_rejection').length;
  if (layer3aCount === 0) {
    process.stderr.write('WARN: primary signal empty — verify rh-layer3a-capture.js wiring (0 layer3a_rejection events in lookback window).\n');
  }
}

function main() {
  // Same-day guard (no instrumentation — sub-millisecond mtime check)
  const guard = checkSameDayGuard();
  if (guard.skip) {
    console.log(JSON.stringify({ ok: true, skipped: 'same-day-guard', last_run_age_hours: guard.ageHours }));
    return;
  }

  // Phase 1 follow-on (2026-05-02): phase-timing instrumentation. Each phase
  // appends to ~/.claude/phase-timing.jsonl with durationMs.
  const cutoffMs = Date.now() - LOOKBACK_DAYS * 86400 * 1000;
  const events = withPhase('rh-learning-loop', 'read-events',
    () => readEventsSince(cutoffMs));
  warnIfPrimarySignalEmpty(events);

  const groups = withPhase('rh-learning-loop', 'build-groups',
    () => buildGroups(events));
  if (groups.length === 0) {
    recordRun();
    console.log(JSON.stringify({ ok: true, groups: 0, reason: 'no-threshold-crossings', total_events: events.length }));
    return;
  }

  // Option B dedup: skip groups already represented by an open `learning-loop` proposal.
  const proposed = withPhase('rh-learning-loop', 'read-dedup-fingerprints',
    () => readOpenProposedFingerprints(RECS_PATH));
  const newGroups = groups.filter(g => !proposed.has(g.event_type + '|' + g.group_key));
  const skipped = groups.length - newGroups.length;

  if (newGroups.length === 0) {
    recordRun();
    console.log(JSON.stringify({
      ok: true,
      groups: groups.length,
      groups_after_dedup: 0,
      groups_skipped_dedup: skipped,
      reason: 'all-groups-already-proposed',
      total_events: events.length,
    }));
    return;
  }

  // Supervisor dispatch is the dominant cost when it fires (multi-minute LLM call).
  const result = withPhase('rh-learning-loop', 'dispatch-supervisor',
    () => dispatchSupervisor(newGroups));
  recordRun();
  console.log(JSON.stringify({
    ok: result.status === 0,
    groups: groups.length,
    groups_after_dedup: newGroups.length,
    groups_skipped_dedup: skipped,
    total_events: events.length,
    supervisor_status: result.status,
    stderr_tail: (result.stderr || '').slice(-400),
  }));
}

if (require.main === module) main();
module.exports = { buildGroups, groupKey, readEventsSince, checkSameDayGuard, readOpenProposedFingerprints };

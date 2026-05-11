#!/usr/bin/env node
// rh-supervisor-sweep.js
//
// Cross-session/project supervisor sweep. Reads structured oversight events
// from a sliding window (default 7 days), aggregates patterns, and writes a
// trend doc at ~/.claude/memory-shared/supervisor-trends.md.
//
// Origin: 2026-05-10 plan P3-1. Depends on P2-1 (subagent_orphan_detected
// events from rh-subagent-orphan-detector.js) and P2-3 (instructions_loaded
// events from rh-instructions-loaded.js) — both already ✅.
//
// Data sources (all already-existing append-only JSONL/Markdown):
//   1. ~/.claude/oversight-events.jsonl — structured event log since 2026-04-25
//   2. <oversight-dir>/supervisory-log.md — Layer3a rejections (best-effort)
//
// Usage:
//   rh-supervisor-sweep [--days N] [--out <path>] [--json] [--dry-run]
//
// Exit codes: 0 ok, 1 IO error, 2 bad usage.

const fs = require('fs');
const path = require('path');
const { config } = require('./lib/config');

function parseArgs(argv) {
  const opts = { days: 7, json: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--days' && argv[i + 1]) opts.days = parseInt(argv[++i], 10);
    else if (a === '--out' && argv[i + 1]) opts.out = argv[++i];
    else if (a === '--json') opts.json = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--events' && argv[i + 1]) opts.eventsPath = argv[++i];
    else if (a === '--supervisory-log' && argv[i + 1]) opts.supervisoryLogPath = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  if (!Number.isFinite(opts.days) || opts.days <= 0) {
    throw new Error(`--days must be a positive integer (got ${argv[argv.indexOf('--days') + 1]})`);
  }
  return opts;
}

// ── Source ingestion ─────────────────────────────────────────────────────

function readEvents(filePath, windowStartMs, windowEndMs) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); }
  catch { return { events: [], totalLines: 0, parsedLines: 0, fileMissing: true }; }
  const lines = raw.split(/\r?\n/);
  const events = [];
  let parsed = 0;
  for (const line of lines) {
    if (!line || line[0] !== '{') continue;
    let ev;
    try { ev = JSON.parse(line); parsed++; } catch { continue; }
    const ts = Date.parse(ev?.timestamp);
    if (!Number.isFinite(ts)) continue;
    if (ts < windowStartMs || ts > windowEndMs) continue;
    events.push({ ...ev, _ts: ts });
  }
  return { events, totalLines: lines.length, parsedLines: parsed, fileMissing: false };
}

function readLayer3aRejections(filePath, windowStartMs, windowEndMs) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); }
  catch { return { rejections: [], fileMissing: true }; }
  // Format produced by layer3a-capture.js:
  //   - **<ISO ts>** | `<sid>` | Layer3a-rejection | <reason>
  const re = /^- \*\*([^*]+)\*\* \| `([^`]+)` \| Layer3a-rejection \| (.+)$/;
  const rejections = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = re.exec(line);
    if (!m) continue;
    const ts = Date.parse(m[1].replace(/ /, 'T').replace(/Z?$/, 'Z'));
    if (!Number.isFinite(ts)) continue;
    if (ts < windowStartMs || ts > windowEndMs) continue;
    rejections.push({ ts, sid: m[2], reason: m[3] });
  }
  return { rejections, fileMissing: false };
}

// ── Aggregation ──────────────────────────────────────────────────────────

function aggregate(events, rejections, windowStartMs, windowEndMs) {
  const byType = new Map();
  const bySid = new Map();
  const byDay = new Map();
  const missingElementsTally = new Map();
  const subagentPatternsTally = new Map();

  for (const ev of events) {
    byType.set(ev.event_type, (byType.get(ev.event_type) || 0) + 1);
    const sid = ev?.data?.session_id || ev?.data?.sessionId || 'unknown';
    bySid.set(sid, (bySid.get(sid) || 0) + 1);
    const day = new Date(ev._ts).toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) || 0) + 1);

    if (ev.event_type === 'oversight_auto_inject') {
      const missing = ev?.data?.missing_elements || [];
      for (const el of missing) {
        missingElementsTally.set(el, (missingElementsTally.get(el) || 0) + 1);
      }
    }
    if (ev.event_type === 'subagent_failure_detected') {
      const patterns = ev?.data?.patterns || [];
      for (const pat of patterns) {
        subagentPatternsTally.set(pat, (subagentPatternsTally.get(pat) || 0) + 1);
      }
    }
  }

  // Rejection aggregation
  const rejectByDay = new Map();
  const rejectBySid = new Map();
  for (const r of rejections) {
    const day = new Date(r.ts).toISOString().slice(0, 10);
    rejectByDay.set(day, (rejectByDay.get(day) || 0) + 1);
    rejectBySid.set(r.sid, (rejectBySid.get(r.sid) || 0) + 1);
  }

  return {
    total: events.length,
    layer3aRejections: rejections.length,
    byType: sortMapDesc(byType),
    byDay: sortMapByKey(byDay),
    bySid: sortMapDesc(bySid, 5),
    missingElements: sortMapDesc(missingElementsTally, 5),
    subagentPatterns: sortMapDesc(subagentPatternsTally, 5),
    rejectByDay: sortMapByKey(rejectByDay),
    rejectBySid: sortMapDesc(rejectBySid, 5),
    windowStart: new Date(windowStartMs).toISOString(),
    windowEnd: new Date(windowEndMs).toISOString(),
  };
}

function sortMapDesc(m, limit) {
  const arr = [...m.entries()].sort((a, b) => b[1] - a[1]);
  return limit ? arr.slice(0, limit) : arr;
}

function sortMapByKey(m) {
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

// ── Rendering ────────────────────────────────────────────────────────────

function renderMarkdown(currentAgg, priorAgg, opts) {
  const lines = [];
  lines.push('# Supervisor Trends');
  lines.push('');
  lines.push('> Auto-generated by `rh-supervisor-sweep`. Do not edit by hand — rerun the script to refresh.');
  lines.push('');
  lines.push(`**Window:** ${currentAgg.windowStart} → ${currentAgg.windowEnd} (${opts.days} day${opts.days === 1 ? '' : 's'})`);
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push('');

  // Summary numbers
  lines.push('## Summary');
  lines.push('');
  const deltaTotal = priorAgg ? currentAgg.total - priorAgg.total : null;
  const deltaRej = priorAgg ? currentAgg.layer3aRejections - priorAgg.layer3aRejections : null;
  lines.push(`| Metric | Current | Prior | Δ |`);
  lines.push(`|---|---:|---:|---:|`);
  lines.push(`| Oversight events | ${currentAgg.total} | ${priorAgg ? priorAgg.total : '—'} | ${formatDelta(deltaTotal)} |`);
  lines.push(`| Layer3a rejections | ${currentAgg.layer3aRejections} | ${priorAgg ? priorAgg.layer3aRejections : '—'} | ${formatDelta(deltaRej)} |`);
  lines.push('');

  // Event type breakdown with delta
  lines.push('## Event types');
  lines.push('');
  if (currentAgg.byType.length === 0) {
    lines.push('_No events in window._');
  } else {
    lines.push('| Event type | Count | Prior | Δ |');
    lines.push('|---|---:|---:|---:|');
    const priorMap = priorAgg ? new Map(priorAgg.byType) : null;
    for (const [type, count] of currentAgg.byType) {
      const priorCount = priorMap ? (priorMap.get(type) || 0) : null;
      const delta = priorCount !== null ? count - priorCount : null;
      lines.push(`| \`${type}\` | ${count} | ${priorCount ?? '—'} | ${formatDelta(delta)} |`);
    }
  }
  lines.push('');

  // Cadence
  lines.push('## Daily cadence');
  lines.push('');
  if (currentAgg.byDay.length === 0) {
    lines.push('_No events to chart._');
  } else {
    const maxCount = Math.max(...currentAgg.byDay.map(([, n]) => n));
    lines.push('```');
    for (const [day, count] of currentAgg.byDay) {
      const bar = '█'.repeat(Math.round((count / maxCount) * 40)) || '·';
      lines.push(`${day}  ${String(count).padStart(4)}  ${bar}`);
    }
    lines.push('```');
  }
  lines.push('');

  // Top patterns
  if (currentAgg.missingElements.length) {
    lines.push('## Top oversight_auto_inject missing elements');
    lines.push('');
    lines.push('| Element | Count |');
    lines.push('|---|---:|');
    for (const [el, n] of currentAgg.missingElements) lines.push(`| \`${el}\` | ${n} |`);
    lines.push('');
  }
  if (currentAgg.subagentPatterns.length) {
    lines.push('## Top subagent_failure patterns');
    lines.push('');
    lines.push('| Pattern | Count |');
    lines.push('|---|---:|');
    for (const [pat, n] of currentAgg.subagentPatterns) lines.push(`| \`${pat}\` | ${n} |`);
    lines.push('');
  }

  // Hot sessions
  if (currentAgg.bySid.length) {
    lines.push('## Top sessions by event count');
    lines.push('');
    lines.push('A high event count for one session usually means that session struggled with the same rule repeatedly.');
    lines.push('');
    lines.push('| Session | Events |');
    lines.push('|---|---:|');
    for (const [sid, n] of currentAgg.bySid) lines.push(`| \`${sid.slice(0, 12)}\` | ${n} |`);
    lines.push('');
  }

  // Layer3a rejection sessions
  if (currentAgg.rejectBySid.length) {
    lines.push('## Top sessions by Layer3a rejection');
    lines.push('');
    lines.push('| Session | Rejections |');
    lines.push('|---|---:|');
    for (const [sid, n] of currentAgg.rejectBySid) lines.push(`| \`${sid.slice(0, 12)}\` | ${n} |`);
    lines.push('');
  }

  // Source verification block
  lines.push('## Source verification');
  lines.push('');
  lines.push('| Source | Range | Lines parsed |');
  lines.push('|---|---|---:|');
  lines.push(`| oversight-events.jsonl | ${currentAgg.windowStart} → ${currentAgg.windowEnd} | ${currentAgg.total} |`);
  lines.push(`| supervisory-log Layer3a | ${currentAgg.windowStart} → ${currentAgg.windowEnd} | ${currentAgg.layer3aRejections} |`);
  lines.push('');

  return lines.join('\n');
}

function formatDelta(d) {
  if (d === null || d === undefined) return '—';
  if (d === 0) return '0';
  return d > 0 ? `+${d}` : `${d}`;
}

// ── Main ─────────────────────────────────────────────────────────────────

function run(argv) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { console.error(e.message); return 2; }
  if (opts.help) { printHelp(); return 0; }

  const eventsPath = opts.eventsPath || config.eventsLogPath;
  // Layer3a rejections live in the supervisory log. Default to oversight-system
  // location if oversightLogPath is set; otherwise scrip-relative default.
  const supervisoryLogPath = opts.supervisoryLogPath || config.oversightLogPath;

  const now = Date.now();
  const windowMs = opts.days * 24 * 60 * 60 * 1000;
  const windowEndMs = now;
  const windowStartMs = now - windowMs;
  const priorEndMs = windowStartMs;
  const priorStartMs = priorEndMs - windowMs;

  const cur = readEvents(eventsPath, windowStartMs, windowEndMs);
  const prior = readEvents(eventsPath, priorStartMs, priorEndMs);
  const curRej = readLayer3aRejections(supervisoryLogPath, windowStartMs, windowEndMs);
  const priorRej = readLayer3aRejections(supervisoryLogPath, priorStartMs, priorEndMs);

  const curAgg = aggregate(cur.events, curRej.rejections, windowStartMs, windowEndMs);
  const priorAgg = aggregate(prior.events, priorRej.rejections, priorStartMs, priorEndMs);

  if (opts.json) {
    const out = JSON.stringify({ current: curAgg, prior: priorAgg, sources: {
      eventsPath, supervisoryLogPath,
      eventsFileMissing: cur.fileMissing,
      supervisoryLogMissing: curRej.fileMissing,
    } }, null, 2);
    if (opts.dryRun) { console.log(out); return 0; }
    const outPath = opts.out || path.join(config.claudeDir, 'memory-shared', 'supervisor-trends.json');
    ensureParent(outPath);
    fs.writeFileSync(outPath, out, 'utf8');
    console.log(`Wrote ${outPath}`);
    return 0;
  }

  const md = renderMarkdown(curAgg, priorAgg, opts);
  if (opts.dryRun) { console.log(md); return 0; }
  const outPath = opts.out || path.join(config.claudeDir, 'memory-shared', 'supervisor-trends.md');
  ensureParent(outPath);
  fs.writeFileSync(outPath, md, 'utf8');
  console.log(`Wrote ${outPath} (${curAgg.total} events, ${curAgg.layer3aRejections} rejections in last ${opts.days}d)`);
  return 0;
}

function ensureParent(p) {
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch {}
}

function printHelp() {
  console.log(`
rh-supervisor-sweep — cross-session/project supervisor trend doc

Usage:
  rh-supervisor-sweep [--days N] [--out <path>] [--json] [--dry-run]

Options:
  --days N             Window size in days (default: 7)
  --out <path>         Output path (default: ~/.claude/memory-shared/supervisor-trends.md)
  --json               Emit JSON instead of markdown
  --dry-run            Print to stdout, don't write
  --events <path>      Override oversight-events.jsonl source (testing)
  --supervisory-log <path>
                       Override supervisory-log.md source (testing)
`);
}

// Export for tests + CLI dispatch
module.exports = {
  run,
  parseArgs,
  readEvents,
  readLayer3aRejections,
  aggregate,
  renderMarkdown,
  formatDelta,
};

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}

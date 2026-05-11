#!/usr/bin/env node
/**
 * rh-auto-prune.js — daily cleanup pass for ephemeral artifacts and aged
 * scribe rows. Safe defaults: dry-run unless --apply.
 *
 * Operations:
 *   1. ~/.claude/settings.json backup pruning — keep 5 most recent (Anthropic
 *      itself caps at 5 per docs/settings).
 *   2. ~/.claude/scribe-pending-*.flag pruning — delete files >24h old.
 *      (Per-session flag should be cleaned up by Stop hook; old ones are
 *      crash residue.)
 *   3. ~/.claude/subagent-active-*.flag pruning — delete files >24h old.
 *      (Pair-flag introduced 2026-05-08 by P2-1; cleanup needed per
 *      sub-bullet 2 of that PR.)
 *   4. ~/.claude/session-marker-*.json pruning — delete files where
 *      startedAt is >30d old (or mtime >30d if startedAt unparseable).
 *      Markers are written by rh-agents-loaded-marker.js on SessionStart;
 *      the file's own docstring documented the 30d stale-age policy as
 *      "until that's wired, manual cleanup is fine." This wires it.
 *   5. Workspace/cleanup.md + recommendations.md — rows with status:resolved
 *      older than 14 days move to Workspace/Archive/scribe-archive-<MONTH>.md.
 *      Rows with status:open older than 30 days emit
 *      scribe_row_review_needed oversight event for the supervisor sweep
 *      (P3-1) to triage.
 *
 * Closes scribe rows: cd3b553b2d (settings backup pruning policy),
 * 3f5e9d389d (stale flag cleanup pattern), and the F-K backlog gap.
 *
 * Usage:
 *   node rh-auto-prune.js               # dry-run
 *   node rh-auto-prune.js --apply       # apply
 *   node rh-auto-prune.js --json        # machine-readable output
 *
 * Exit code: always 0 unless catastrophic failure.
 */

const fs = require('fs');
const path = require('path');
const { config } = require('./lib/config');
const { appendOversightEvent } = require('./lib/oversight-events');

const APPLY = process.argv.includes('--apply');
const JSON_OUT = process.argv.includes('--json');

const DAY_MS = 24 * 3600 * 1000;
const ARCHIVE_RESOLVED_DAYS = 14;
const ALERT_OPEN_DAYS = 30;
const SETTINGS_BACKUP_KEEP = 5;
const FLAG_AGE_DAYS = 1;
const SESSION_MARKER_AGE_DAYS = 30;

function safeStat(p) { try { return fs.statSync(p); } catch { return null; } }

function listMatching(dir, predicate) {
  try {
    return fs.readdirSync(dir).filter(predicate).map(f => {
      const p = path.join(dir, f);
      const stat = safeStat(p);
      return stat ? { name: f, path: p, mtime: stat.mtimeMs, size: stat.size } : null;
    }).filter(Boolean);
  } catch { return []; }
}

// ─── 1. Settings backups ─────────────────────────────────────────────────

function pruneSettingsBackups() {
  const backups = listMatching(config.claudeDir, f =>
    /^settings\.json\.(bak|backup|pre-)/.test(f)
  ).sort((a, b) => b.mtime - a.mtime);

  const toRemove = backups.slice(SETTINGS_BACKUP_KEEP);
  let removed = 0;
  for (const b of toRemove) {
    if (APPLY) { try { fs.unlinkSync(b.path); removed++; } catch {} }
  }
  return {
    kept: Math.min(SETTINGS_BACKUP_KEEP, backups.length),
    candidates: toRemove.length,
    removed: APPLY ? removed : 0,
    files: toRemove.map(b => b.name),
  };
}

// ─── 2/3. Ephemeral flag files ───────────────────────────────────────────

function pruneFlags(prefix) {
  const cutoff = Date.now() - FLAG_AGE_DAYS * DAY_MS;
  const flags = listMatching(config.claudeDir, f => f.startsWith(prefix)).filter(b => b.mtime < cutoff);
  let removed = 0;
  for (const b of flags) {
    if (APPLY) { try { fs.unlinkSync(b.path); removed++; } catch {} }
  }
  return {
    candidates: flags.length,
    removed: APPLY ? removed : 0,
    files: flags.map(b => b.name).slice(0, 20),
  };
}

// ─── 4. Session markers ──────────────────────────────────────────────────

function pruneSessionMarkers() {
  const cutoff = Date.now() - SESSION_MARKER_AGE_DAYS * DAY_MS;
  const candidates = listMatching(config.claudeDir, f =>
    /^session-marker-.*\.json$/.test(f)
  );
  const stale = [];
  for (const m of candidates) {
    let startedAtMs = NaN;
    try {
      const j = JSON.parse(fs.readFileSync(m.path, 'utf8'));
      if (j?.startedAt) startedAtMs = Date.parse(j.startedAt);
    } catch {}
    const ageRef = isNaN(startedAtMs) ? m.mtime : startedAtMs;
    if (ageRef < cutoff) stale.push({ ...m, startedAtMs });
  }
  let removed = 0;
  for (const m of stale) {
    if (APPLY) { try { fs.unlinkSync(m.path); removed++; } catch {} }
  }
  return {
    candidates: stale.length,
    removed: APPLY ? removed : 0,
    files: stale.map(m => m.name).slice(0, 20),
  };
}

// ─── 4b. Scribe staging files (P1-3) ─────────────────────────────────────

function pruneScribeStaging() {
  // Wraps lib/scribe-staging.pruneStale. TTL is owned by the staging lib
  // (7 days); we just trigger the sweep here. Always runs in apply mode —
  // staging files are append-only and ephemeral by design, never user-edited.
  if (!APPLY) {
    // Dry-run: count what would be removed without deleting.
    const fs2 = require('fs');
    const path2 = require('path');
    const staging = require('./lib/scribe-staging');
    const dir = staging.stagingDir();
    let candidates = 0;
    try {
      const now = Date.now();
      for (const name of fs2.readdirSync(dir)) {
        if (!name.startsWith('staging-') && !name.startsWith('offset-')) continue;
        const fp = path2.join(dir, name);
        try {
          const st = fs2.statSync(fp);
          if (now - st.mtimeMs > staging.STAGING_TTL_MS) candidates++;
        } catch {}
      }
    } catch {}
    return { candidates, removed: 0 };
  }
  const staging = require('./lib/scribe-staging');
  const { stagingRemoved, offsetRemoved } = staging.pruneStale();
  return {
    candidates: stagingRemoved + offsetRemoved,
    removed: stagingRemoved + offsetRemoved,
    staging_files: stagingRemoved,
    offset_files: offsetRemoved,
  };
}

// ─── 5. Scribe rows ──────────────────────────────────────────────────────

function pruneScribeFile(filePath) {
  if (!fs.existsSync(filePath)) return { archived: 0, staleOpen: 0, file: filePath };
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const now = Date.now();
  const archiveCutoff = now - ARCHIVE_RESOLVED_DAYS * DAY_MS;
  const alertCutoff = now - ALERT_OPEN_DAYS * DAY_MS;

  const archived = [];
  const staleOpenIds = [];
  const kept = [];

  // Match scribe row: | id | ts | session | text | status |
  // ID is hex, 8-16 chars; ts is YYYY-MM-DD or ISO datetime.
  const rowRe = /^\|\s*([a-f0-9]{8,16})\s*\|\s*(\d{4}-\d{2}-\d{2})/;
  for (const line of lines) {
    const m = line.match(rowRe);
    if (!m) { kept.push(line); continue; }
    const ts = Date.parse(m[2]);
    if (isNaN(ts)) { kept.push(line); continue; }

    const isResolved = / \|\s*resolved\s*\|/.test(line);
    const isOpen = / \|\s*open\s*\|/.test(line);

    if (isResolved && ts < archiveCutoff) {
      archived.push(line);
      continue; // omit from kept (gets archived)
    }
    if (isOpen && ts < alertCutoff) {
      staleOpenIds.push(m[1]);
    }
    kept.push(line);
  }

  if (APPLY && archived.length > 0) {
    fs.writeFileSync(filePath, kept.join('\n'), 'utf8');
    const archiveDir = path.join(path.dirname(filePath), 'Archive');
    if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 7);
    const archiveFile = path.join(archiveDir, `scribe-archive-${stamp}.md`);
    const block =
      `\n## Archived from ${path.basename(filePath)} on ${new Date().toISOString().slice(0, 10)}\n\n` +
      `| id | ts | session | text | status |\n|---|---|---|---|---|\n${archived.join('\n')}\n`;
    fs.appendFileSync(archiveFile, block, 'utf8');
  }

  if (APPLY && staleOpenIds.length > 0) {
    appendOversightEvent('scribe_row_review_needed', {
      file: path.basename(filePath),
      stale_open_count: staleOpenIds.length,
      sample_ids: staleOpenIds.slice(0, 10),
      threshold_days: ALERT_OPEN_DAYS,
      note: `Open scribe rows older than ${ALERT_OPEN_DAYS}d in ${path.basename(filePath)}. Review or archive.`,
    });
  }

  return {
    file: path.basename(filePath),
    archived_count: archived.length,
    archived_ids: archived.map(l => l.match(rowRe)?.[1]).filter(Boolean).slice(0, 20),
    stale_open_count: staleOpenIds.length,
    stale_open_ids: staleOpenIds.slice(0, 20),
  };
}

// ─── Main ────────────────────────────────────────────────────────────────

function main() {
  const result = {
    mode: APPLY ? 'apply' : 'dry-run',
    timestamp: new Date().toISOString(),
    settings_backups: pruneSettingsBackups(),
    scribe_pending_flags: pruneFlags('scribe-pending-'),
    subagent_active_flags: pruneFlags('subagent-active-'),
    session_markers: pruneSessionMarkers(),
    scribe_staging: pruneScribeStaging(),
    scribe_files: [
      pruneScribeFile(path.join(config.workspace, 'cleanup.md')),
      pruneScribeFile(path.join(config.workspace, 'recommendations.md')),
    ],
  };

  if (JSON_OUT) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`[auto-prune] mode=${result.mode}`);
  console.log(`  settings backups: kept ${result.settings_backups.kept}, ${APPLY ? 'removed' : 'would remove'} ${result.settings_backups.candidates}`);
  console.log(`  scribe-pending flags: ${APPLY ? 'removed' : 'would remove'} ${result.scribe_pending_flags.candidates}`);
  console.log(`  subagent-active flags: ${APPLY ? 'removed' : 'would remove'} ${result.subagent_active_flags.candidates}`);
  console.log(`  session markers (>${SESSION_MARKER_AGE_DAYS}d): ${APPLY ? 'removed' : 'would remove'} ${result.session_markers.candidates}`);
  console.log(`  scribe staging (>7d): ${APPLY ? 'removed' : 'would remove'} ${result.scribe_staging.candidates}`);
  for (const sf of result.scribe_files) {
    console.log(`  ${sf.file}: ${APPLY ? 'archived' : 'would archive'} ${sf.archived_count} resolved>${ARCHIVE_RESOLVED_DAYS}d, ${sf.stale_open_count} open>${ALERT_OPEN_DAYS}d ${APPLY ? 'alerted' : 'would alert'}`);
  }
  if (!APPLY) console.log(`\n  Re-run with --apply to act.`);
}

try { main(); } catch (e) {
  console.error(`[auto-prune] FATAL: ${e.message}`);
  process.exit(1);
}

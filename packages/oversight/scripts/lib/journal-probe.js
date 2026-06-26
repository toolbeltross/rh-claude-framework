// journal-probe.js — config-driven staleness probe shared by
// rh-daily-regen-trigger.js (emits oversight events) and
// rh-oversight-health.js (surfaces in health output).
//
// Reads ~/.claude/journals.json (or path passed in opts). Schema:
//
//   [
//     {
//       "name": "supervisory-log",
//       "path": "~/.claude/telemetry-supervisory-log.md",
//       "threshold_hours": 24,
//       "alert_event_type": "journal_staleness_alert",
//       "note": "Supervisory log unwritten — verify hook-forwarder.js stop is firing",
//       "alert_on_missing": false
//     }
//   ]
//
// Path expansion: `~/...` → home; `.claude/...` → workspace; absolute paths used as-is.
// `alert_on_missing`: when true, missing file emits the alert (default: false; useful
// for append-only logs where missing means cold-start, but mtime-tracked markers should
// alert).
//
// Returns: array of probe results (level: ok|warn|crit, age_hours, file).
// Caller decides whether to emit events / print / exit-code.

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const DEFAULT_MANIFEST = path.join(HOME, '.claude', 'journals.json');

function expand(p, opts = {}) {
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2));
  if (p.startsWith('.claude/') && opts.workspace) return path.join(opts.workspace, p);
  return p;
}

function loadManifest(manifestPath = DEFAULT_MANIFEST) {
  try {
    if (!fs.existsSync(manifestPath)) return [];
    const data = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!Array.isArray(data)) {
      throw new Error('journals.json must be a JSON array');
    }
    return data;
  } catch (e) {
    // Don't throw — journal probe must never block. Return empty + log if available.
    process.stderr && process.stderr.write && process.stderr.write(`[journal-probe] manifest load error: ${e.message}\n`);
    return [];
  }
}

/**
 * Run all probes from the manifest.
 *
 * @param {object} opts
 * @param {string} [opts.manifestPath] — defaults to ~/.claude/journals.json
 * @param {string} [opts.workspace]    — for `.claude/...` path expansion
 * @param {function} [opts.emit]       — receives (eventType, data) for staleness events
 * @returns {Array<{name,path,age_hours,threshold_hours,level,exists,alert_event_type}>}
 */
function runProbes(opts = {}) {
  const manifest = loadManifest(opts.manifestPath);
  const results = [];
  for (const entry of manifest) {
    if (!entry || !entry.path || typeof entry.threshold_hours !== 'number') continue;
    const expanded = expand(entry.path, opts);
    const exists = fs.existsSync(expanded);
    const result = {
      name: entry.name || path.basename(expanded),
      path: expanded,
      threshold_hours: entry.threshold_hours,
      alert_event_type: entry.alert_event_type || 'journal_staleness_alert',
      exists,
      age_hours: null,
      level: 'ok',
    };

    if (!exists) {
      if (entry.alert_on_missing) {
        result.level = 'crit';
        if (opts.emit) opts.emit(result.alert_event_type, {
          journal_name: result.name,
          path: expanded,
          missing: true,
          threshold_hours: entry.threshold_hours,
          note: entry.note || '',
        });
      } else {
        result.level = 'info';
      }
      results.push(result);
      continue;
    }

    try {
      const stat = fs.statSync(expanded);
      const ageMs = Date.now() - stat.mtimeMs;
      const ageH = ageMs / 3_600_000;
      result.age_hours = Math.round(ageH * 10) / 10;
      const thresholdMs = entry.threshold_hours * 3_600_000;
      if (ageMs > thresholdMs * 3) result.level = 'crit';
      else if (ageMs > thresholdMs) result.level = 'warn';
      // Emit only when threshold crossed (warn or crit).
      if ((result.level === 'warn' || result.level === 'crit') && opts.emit) {
        opts.emit(result.alert_event_type, {
          journal_name: result.name,
          path: expanded,
          last_mtime: new Date(stat.mtimeMs).toISOString(),
          age_hours: Math.round(ageH),
          threshold_hours: entry.threshold_hours,
          note: entry.note || '',
        });
      }
    } catch (e) {
      result.level = 'warn';
      result.error = e.message;
    }
    results.push(result);
  }
  return results;
}

module.exports = { runProbes, loadManifest, DEFAULT_MANIFEST };

/**
 * D5 — Hook-forwarder self-health.
 *
 * Reads the tail of `hook-debug.log` (written by scripts/hook-forwarder.js) and
 * extracts enough signal to answer: "are my hooks actually working?" The log
 * is rotate-aware — once the live file hits 10MB, hook-forwarder renames it
 * to `.1`, and a fresh file starts. We only look at the live file; the .1
 * archive is historical.
 *
 * This is a passive reader — no writes, no mutation.
 */
import { readFileSync, statSync, existsSync } from 'fs';
import { dirname, resolve, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const LOG_FILE = join(PROJECT_ROOT, 'hook-debug.log');

// Keywords that indicate a problem in the log. Intentionally broad: the log
// is unstructured text and false positives are OK — the chip is directional,
// not a precise alarm.
const ERROR_PATTERNS = [
  /error[:\s]/i,
  /\[ERROR\]/i,
  /failed/i,
  /timeout/i,
  /ENOENT/i,
  /EACCES/i,
  /refused/i,
];

/** Read the last `bytes` of a file, return as UTF-8 string. Safe on partial reads. */
function readTail(path, bytes = 256 * 1024) {
  try {
    const st = statSync(path);
    const size = st.size;
    const start = Math.max(0, size - bytes);
    const fd = readFileSync(path, { encoding: 'utf-8' });
    // Can't do an efficient partial read without fs.open — just slice.
    // At 256KB this is fine even on OneDrive. If it gets slow, swap to
    // fs.openSync + read + close.
    return fd.slice(start);
  } catch {
    return '';
  }
}

/**
 * Parse transcript-parse latency lines like:
 *   [2026-04-10T03:38:27.959Z] transcript parse: 1ms, partial=true, lines=45
 * Returns an array of { ts, ms }.
 */
function parseTranscriptLatencies(text) {
  const out = [];
  const re = /\[(\d{4}-\d{2}-\d{2}T[\d:.Z-]+)\]\s+transcript parse:\s+(\d+)ms/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push({ ts: m[1], ms: parseInt(m[2], 10) });
  }
  return out;
}

/** percentile: p=0.95 → return value at 95th percentile. */
function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

/**
 * Return a snapshot of hook-forwarder health:
 * - exists: is the log file present?
 * - fileSizeBytes: total size (for rotation visibility)
 * - recentErrors: last N error-containing lines (newest first)
 * - errorCount: total error lines in the tail
 * - transcriptP95Ms: 95th-percentile transcript parse latency in recent tail
 * - transcriptSamples: number of parse-latency samples considered
 * - healthy: true when no errors in the last tail and the file exists
 */
export function getHookHealth({ tailBytes = 256 * 1024, maxErrorLines = 20, logPath = LOG_FILE } = {}) {
  if (!existsSync(logPath)) {
    return {
      exists: false,
      healthy: false,
      reason: 'hook-debug.log not found — has the forwarder ever run?',
      logPath,
      fileSizeBytes: 0,
      recentErrors: [],
      errorCount: 0,
      transcriptP95Ms: 0,
      transcriptSamples: 0,
    };
  }

  let fileSizeBytes = 0;
  try {
    fileSizeBytes = statSync(logPath).size;
  } catch {}

  const text = readTail(logPath, tailBytes);
  if (!text) {
    return {
      exists: true,
      healthy: false,
      reason: 'log exists but could not be read',
      logPath,
      fileSizeBytes,
      recentErrors: [],
      errorCount: 0,
      transcriptP95Ms: 0,
      transcriptSamples: 0,
    };
  }

  const lines = text.split('\n');
  const errors = [];
  for (let i = lines.length - 1; i >= 0 && errors.length < maxErrorLines; i--) {
    const line = lines[i];
    if (!line) continue;
    if (ERROR_PATTERNS.some((re) => re.test(line))) {
      errors.push(line.slice(0, 500));
    }
  }

  const latencies = parseTranscriptLatencies(text).map((x) => x.ms);
  const transcriptP95Ms = percentile(latencies, 0.95);

  return {
    exists: true,
    healthy: errors.length === 0,
    reason: errors.length === 0 ? null : `${errors.length} error line${errors.length > 1 ? 's' : ''} in recent log tail`,
    logPath,
    fileSizeBytes,
    recentErrors: errors,
    errorCount: errors.length,
    transcriptP95Ms,
    transcriptSamples: latencies.length,
  };
}

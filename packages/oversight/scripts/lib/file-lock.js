// file-lock.js — lockfile-with-jitter for read-modify-write file ops.
//
// Extracted 2026-05-02 from rh-scribe-prefilter.js appendRowsToFile (Phase 1
// C1 of PLAN-oversight-improvements-2026-05-02.md). The original pattern was
// verified to 32-way parallel under stress test prior to extraction.
//
// CONTRACT: the work function MUST do its own read + write inside the
// callback. TOCTOU races occur if reads happen outside — multiple writers
// can each capture stale pre-modification state and then take turns writing
// back stale-plus-their-row, overwriting each other's work. Verified
// empirically (8-way stress observed all 16 rows lost AND prior content
// deleted before this constraint was enforced).
//
// USAGE:
//   const { withLock } = require('./lib/file-lock');
//   const result = withLock('/path/to/file.md', () => {
//     const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
//     const newContent = transform(content);
//     fs.writeFileSync(filePath, newContent, 'utf8');
//     return /* anything */;
//   });
//
// On lock-acquisition failure after all retries, returns undefined.
// The work function's return value propagates on success.

const fs = require('fs');

const DEFAULT_RETRIES = 30;
const DEFAULT_BASE_WAIT_MS = 40;
const STALE_LOCK_MS = 5000;

function withLock(filePath, fn, opts = {}) {
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const baseWaitMs = opts.baseWaitMs ?? DEFAULT_BASE_WAIT_MS;
  const lockPath = filePath + '.lock';

  for (let i = 0; i < retries; i++) {
    // Acquire lock — retry on ANY error (EEXIST, EBUSY, EPERM, etc.). On
    // Windows under contention, transient EBUSY/EPERM are common; silently
    // bailing here is what caused the 16-way stress test to drop ~half the
    // writers in earlier iterations. Do NOT narrow to EEXIST.
    let acquired = false;
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      acquired = true;
    } catch (e) {
      // Stale lock recovery (only meaningful for EEXIST, but cheap to try always)
      try {
        const lockAge = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (lockAge > STALE_LOCK_MS) { try { fs.unlinkSync(lockPath); } catch {} }
      } catch {}
    }

    if (!acquired) {
      const wait = baseWaitMs * (1 + i) + Math.floor(Math.random() * baseWaitMs);
      const start = Date.now();
      while (Date.now() - start < wait) { /* spin — single-threaded hook context */ }
      continue;
    }

    // Inside lock: run the work function. try/finally guarantees lock release.
    try {
      return fn();
    } finally {
      try { fs.unlinkSync(lockPath); } catch {}
    }
  }

  return undefined;  // failed to acquire after all retries
}

module.exports = { withLock };

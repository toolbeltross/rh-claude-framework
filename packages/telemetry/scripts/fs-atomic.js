// fs-atomic.js (ESM) — atomic file replacement for the telemetry scripts.
//
// Mirrors packages/shared/fs-atomic.js. Reimplemented here because telemetry is
// the monorepo's ESM island and cannot `require()` the CJS shared module.
//
// Write to a sibling temp file, then rename over the target — rename is atomic
// on the same volume (POSIX + NTFS), so an interrupted write (crash, OneDrive/AV
// lock) can never leave the user's shared ~/.claude/settings.json truncated.

import { writeFileSync, renameSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { dirname } from 'path';

let _counter = 0;
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES']);

export function writeFileAtomic(filePath, data, opts = {}) {
  const encoding = opts.encoding || 'utf8';
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const tmp = `${filePath}.tmp.${process.pid}.${++_counter}`;
  const writeOpts = { encoding };
  if (opts.mode !== undefined) writeOpts.mode = opts.mode;
  writeFileSync(tmp, data, writeOpts);

  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, filePath);
      return;
    } catch (e) {
      if (attempt >= 10 || !TRANSIENT.has(e.code)) {
        try { unlinkSync(tmp); } catch {}
        throw e;
      }
      const until = Date.now() + 20 * (attempt + 1);
      while (Date.now() < until) { /* brief backoff — one-shot CLI context */ }
    }
  }
}

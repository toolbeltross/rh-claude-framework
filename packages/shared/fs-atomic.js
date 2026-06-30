// fs-atomic.js — atomic file replacement (write-temp-then-rename).
//
// Why: a direct fs.writeFileSync truncates the target, then writes. If the
// process is interrupted mid-write (Ctrl-C, crash, OneDrive/AV lock on Windows),
// the file is left truncated/empty. For shared config files (~/.claude/
// settings.json, oversight.json, .pgpass) that corruption can destroy a user's
// existing configuration. writeFileAtomic writes to a sibling temp file and then
// renames it over the target — rename is atomic on the same volume (POSIX + NTFS),
// so a reader never sees a half-written file and a crash leaves the original intact.
//
// USAGE:
//   const { writeFileAtomic } = require('@rh/shared');   // or require('./fs-atomic')
//   writeFileAtomic('/path/to/config.json', JSON.stringify(obj, null, 2) + '\n');
//   writeFileAtomic(pgpassPath, body, { mode: 0o600 });  // restrict perms from creation
//
// Pair with withLock when concurrent writers do read-modify-write on the same
// file — writeFileAtomic prevents torn reads; withLock prevents lost updates.

const fs = require('fs');
const path = require('path');

let _counter = 0;

// Transient Windows lock errors seen under OneDrive / AV contention — the rename
// can briefly fail while the target is held. Retry a few times before giving up.
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES']);

function writeFileAtomic(filePath, data, opts = {}) {
  const encoding = opts.encoding || 'utf8';
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Sibling temp file (same dir → same volume → atomic rename). Unique per
  // process + call so concurrent writers in one process don't collide.
  const tmp = `${filePath}.tmp.${process.pid}.${++_counter}`;
  const writeOpts = { encoding };
  if (opts.mode !== undefined) writeOpts.mode = opts.mode;
  fs.writeFileSync(tmp, data, writeOpts);

  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, filePath);
      return;
    } catch (e) {
      if (attempt >= 10 || !TRANSIENT.has(e.code)) {
        try { fs.unlinkSync(tmp); } catch {}
        throw e;
      }
      const until = Date.now() + 20 * (attempt + 1);
      while (Date.now() < until) { /* brief backoff — installer/CLI context */ }
    }
  }
}

module.exports = { writeFileAtomic };

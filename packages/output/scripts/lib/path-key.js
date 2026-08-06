// path-key.js — portable, home-relative keys for scribe rows.
//
// WHY THIS EXISTS (2026-08-02). scribe_rows.source_file stored an ABSOLUTE path,
// and `rh-scribe-query.js` overlays proposals onto MD rows keyed by
// (bucket, source_file, row_id). The 2026-07-28 OneDrive migration changed that
// absolute path, orphaning 866 of 1,320 rows and stranding 591 LLM proposals on
// files that no longer existed. The overlay could never match them again.
//
// An absolute key is wrong for this workspace on three axes:
//   - relocation  (OneDrive -> local, which is what broke it)
//   - multi-device (Spindrift `C:\Users\<user>`, Conspire `C:\Users\Ross Anon`,
//                   a Mac mini with a POSIX home)
//   - two accounts (work / home, each with its own ~/.claude tree)
//
// So keys are stored HOME-RELATIVE with a leading `~/` and forward slashes:
//     C:\Users\<user>\Workspace\cleanup.md            -> ~/Workspace/cleanup.md
//     /Users/<user>/.claude/memory-shared/learnings/x.md -> ~/.claude/memory-shared/learnings/x.md
//
// This is not a new convention: the `learnings` bucket already stored
// `~/.claude/memory-shared/learnings/*.md`. This generalises what was already there.
//
// Paths outside the home directory keep their absolute form (normalised to
// forward slashes) — they are genuinely machine-specific and must not be faked
// into a portable key.

const os = require('os');

// Mirrors @rh/shared/env.js homeDir(). Kept self-contained so the deployed copy
// under ~/.claude/scripts/lib/ has no cross-package relative dependency.
function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

const SEP = /[\\/]+/g;
// Git-bash / msys renders Windows drives as /c/Users/... . Rows written from a bash-hosted
// script therefore carry a different string for the SAME file than rows written from Node
// (C:/Users/...). Fold msys form back to drive form so both produce one key. Observed live:
// one learnings row keyed `/c/Users/<user>/.claude/...`.
const MSYS_DRIVE = /^\/([a-zA-Z])\//;
function norm(p) {
  let s = String(p == null ? '' : p).replace(SEP, '/').replace(/\/+$/, '');
  const m = MSYS_DRIVE.exec(s);
  if (m) s = m[1].toUpperCase() + ':/' + s.slice(3);
  return s;
}

// Windows paths are case-insensitive; POSIX are not.
const isWin = () => process.platform === 'win32';
const cmp = (s) => (isWin() ? s.toLowerCase() : s);

/** Absolute (or already-keyed) path -> portable `~/...` key. Idempotent. */
function toKey(p) {
  const n = norm(p);
  if (!n) return '';
  if (n.startsWith('~/') || n === '~') return n;      // already a key
  const h = norm(homeDir());
  if (!h) return n;
  if (cmp(n) === cmp(h)) return '~';
  if (cmp(n).startsWith(cmp(h) + '/')) return '~/' + n.slice(h.length + 1);
  return n;                                            // outside home: keep absolute
}

/** Portable key -> absolute path on THIS machine. Idempotent. */
function fromKey(k) {
  const n = norm(k);
  if (!n) return '';
  if (n === '~') return norm(homeDir());
  if (n.startsWith('~/')) return norm(homeDir()) + '/' + n.slice(2);
  return n;
}

/** True when two paths/keys point at the same file on this machine. */
function sameTarget(a, b) {
  return cmp(norm(fromKey(a))) === cmp(norm(fromKey(b)));
}

module.exports = { toKey, fromKey, sameTarget, homeDir, norm };

// Tests for lib/path-key.js — portable home-relative scribe keys.
//
// Regression cover for the 2026-07-28 relocation break: scribe_rows.source_file held an
// ABSOLUTE path, so moving the workspace orphaned 866 of 1,320 rows and stranded 591 LLM
// proposals. The same failure recurs across devices (Spindrift `C:\Users\testuser`, Conspire
// `C:\Users\Ross Anon`, a Mac mini POSIX home) and across the two Claude accounts.

const assert = require('assert');
const path = require('path');

const pk = require(path.join(__dirname, '..', 'scripts', 'lib', 'path-key.js'));

// Drive homeDir() through the env var it reads, so tests are machine-independent.
function withHome(home, fn) {
  const oldH = process.env.HOME, oldU = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home;
  try { return fn(); } finally {
    if (oldH === undefined) delete process.env.HOME; else process.env.HOME = oldH;
    if (oldU === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldU;
  }
}

const tests = [
  {
    name: 'toKey: workspace file under home becomes ~/-relative',
    fn: () => withHome('C:/Users/testuser', () => {
      assert.strictEqual(pk.toKey('C:/Users/testuser/Workspace/cleanup.md'), '~/Workspace/cleanup.md');
    }),
  },
  {
    name: 'toKey: backslashes normalise to forward slashes',
    fn: () => withHome('C:/Users/testuser', () => {
      assert.strictEqual(pk.toKey('C:\\Users\\testuser\\Workspace\\cleanup.md'), '~/Workspace/cleanup.md');
    }),
  },
  {
    name: 'toKey is idempotent — re-keying an existing key is a no-op',
    fn: () => withHome('C:/Users/testuser', () => {
      const once = pk.toKey('C:/Users/testuser/Workspace/cleanup.md');
      assert.strictEqual(pk.toKey(once), once);
    }),
  },
  {
    name: 'toKey: the learnings bucket convention already in the DB round-trips unchanged',
    fn: () => withHome('C:/Users/testuser', () => {
      const k = '~/.claude/memory-shared/learnings/x.md';
      assert.strictEqual(pk.toKey(k), k);
    }),
  },
  {
    name: 'toKey: a path OUTSIDE home keeps its absolute form (must not be faked portable)',
    fn: () => withHome('C:/Users/testuser', () => {
      assert.strictEqual(pk.toKey('D:/Shared/other.md'), 'D:/Shared/other.md');
    }),
  },
  {
    name: 'MULTI-DEVICE: one key resolves correctly on each machine',
    fn: () => {
      const key = '~/Workspace/cleanup.md';
      // Spindrift
      withHome('C:/Users/testuser', () => {
        assert.strictEqual(pk.fromKey(key), 'C:/Users/testuser/Workspace/cleanup.md');
      });
      // Conspire — note the SPACE in the user name
      withHome('C:/Users/Ross Anon', () => {
        assert.strictEqual(pk.fromKey(key), 'C:/Users/Ross Anon/Workspace/cleanup.md');
      });
      // Mac mini
      withHome('/Users/ross', () => {
        assert.strictEqual(pk.fromKey(key), '/Users/ross/Workspace/cleanup.md');
      });
    },
  },
  {
    name: 'MULTI-DEVICE: a key written on one box matches the same file on another',
    fn: () => {
      const written = withHome('C:/Users/testuser', () => pk.toKey('C:/Users/testuser/Workspace/cleanup.md'));
      const matches = withHome('C:/Users/Ross Anon', () => pk.toKey('C:/Users/Ross Anon/Workspace/cleanup.md'));
      assert.strictEqual(written, matches, 'same logical file must yield the same key on both devices');
    },
  },
  {
    name: 'REGRESSION: the 2026-07-28 relocation would no longer orphan the row',
    fn: () => withHome('C:/Users/testuser', () => {
      const before = pk.toKey('C:/Users/testuser/CloudSync/Workspace/cleanup.md');
      const after = pk.toKey('C:/Users/testuser/Workspace/cleanup.md');
      // They differ (the file genuinely moved), but BOTH are portable keys — neither
      // encodes a machine identity, so re-keying is a one-time data fix, not a recurrence.
      assert.ok(before.startsWith('~/'), 'pre-move path is still expressed portably');
      assert.ok(after.startsWith('~/'), 'post-move path is expressed portably');
      assert.notStrictEqual(before, after);
    }),
  },
  {
    name: 'fromKey/toKey round-trip',
    fn: () => withHome('C:/Users/testuser', () => {
      const abs = 'C:/Users/testuser/Workspace/recommendations.md';
      assert.strictEqual(pk.fromKey(pk.toKey(abs)), abs);
    }),
  },
  {
    name: 'sameTarget: legacy absolute row and new key resolve to the same file',
    fn: () => withHome('C:/Users/testuser', () => {
      assert.ok(pk.sameTarget('C:\\Users\\testuser\\Workspace\\cleanup.md', '~/Workspace/cleanup.md'));
      assert.ok(!pk.sameTarget('~/Workspace/cleanup.md', '~/Workspace/recommendations.md'));
    }),
  },
  {
    name: 'msys/git-bash drive form folds to the same key as the Node form',
    fn: () => withHome('C:/Users/testuser', () => {
      // A row written from a bash-hosted script carried `/c/Users/...` for the same file
      // a Node-hosted script wrote as `C:/Users/...`. Both must yield one key.
      assert.strictEqual(
        pk.toKey('/c/Users/testuser/.claude/memory-shared/learnings/x.md'),
        '~/.claude/memory-shared/learnings/x.md');
      assert.ok(pk.sameTarget('/c/Users/testuser/Workspace/cleanup.md', 'C:/Users/testuser/Workspace/cleanup.md'));
    }),
  },
  {
    name: 'empty / null input does not throw',
    fn: () => withHome('C:/Users/testuser', () => {
      assert.strictEqual(pk.toKey(''), '');
      assert.strictEqual(pk.toKey(null), '');
      assert.strictEqual(pk.fromKey(''), '');
    }),
  },
];

module.exports = { tests };

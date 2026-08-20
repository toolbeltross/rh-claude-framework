// Convention guard — encodes the CLAUDE.md "zero hardcoded user paths" rule as
// a regression test. Shipped packages/ must be free of machine-specific identity
// references: the Windows username, the user's OneDrive workspace path, and the
// personal setup folder. This protects the public-repo hygiene established by
// PR #67 (telemetry docs) and PR #70 (shipped code) from silently regressing.
//
// Legitimate `toolbeltross` repo references (package URLs, etc.) are allowed and
// not matched. This file excludes itself from the scan and builds its patterns
// from fragments so the literal terms never appear here (otherwise the manual
// convention grep would flag this very file).

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const PACKAGES_DIR = path.join(__dirname, '..', '..');   // .../packages
const SELF = path.basename(__filename);

// Patterns assembled from fragments so the literal identity strings are absent
// from this source file.
const IDENTITY = new RegExp(
  ['ross' + 'b', 'OneDrive\\/Work' + 'space', 'claude-setup-' + 'ross'].join('|')
);

// Split-literal form: the same personal paths assembled from separate path.join
// string args, e.g. path.join(config.home, 'OneDrive', 'Workspace', ...) or the
// maintainer's repo nesting. The single-line IDENTITY regex above misses these
// because the segments are joined by ", " rather than "/".
//
// QUOTE-AGNOSTIC (2026-08-19). This pattern was single-quote-only, which left a
// blind spot the size of the violation it was written to catch: rh-fw.js:46/:65
// and rh-daily-validate.js:87 carried the identical literals in DOUBLE quotes
// and passed clean for as long as the test has existed, while the
// single-quoted twins in rh-config-integrity.js failed the suite. Both quote
// styles are now matched, so the guard can't be sidestepped by a style choice.
const Q = "['\"]";
const SPLIT_IDENTITY = new RegExp(
  [Q + "One" + "Drive" + Q + "\\s*,\\s*" + Q + "Work" + "space" + Q,
   Q + "toolbeltross-pub" + "lic" + Q + "\\s*,\\s*" + Q + "rh-claude-frame" + "work" + Q].join('|')
);

const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-v2', '.git', 'coverage']);
const EXTS = new Set(['.js', '.mjs', '.cjs', '.md', '.json']);

function walk(dir, hits) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) walk(full, hits);
    } else if (EXTS.has(path.extname(ent.name)) && ent.name !== SELF) {
      const lines = fs.readFileSync(full, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (IDENTITY.test(line) || SPLIT_IDENTITY.test(line)) {
          hits.push(`${path.relative(PACKAGES_DIR, full).replace(/\\/g, '/')}:${i + 1}: ${line.trim().slice(0, 100)}`);
        }
      });
    }
  }
}

const tests = [
  {
    name: 'shipped packages/ is free of machine-specific identity refs (CLAUDE.md zero-hardcoded-paths convention)',
    fn: () => {
      const hits = [];
      walk(PACKAGES_DIR, hits);
      assert.strictEqual(
        hits.length, 0,
        `found ${hits.length} machine-specific identity ref(s) in shipped packages/ ` +
        `(see CLAUDE.md zero-hardcoded-paths rule — use placeholders like <workspace>/<user-setup>):\n` +
        hits.join('\n')
      );
    },
  },
];

module.exports = { tests };

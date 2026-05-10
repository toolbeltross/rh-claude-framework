// SHIM — source-tree only.
//
// Canonical implementation lives at packages/shared/file-lock.js.
// At install time, the installer copies packages/shared/file-lock.js
// directly to ~/.claude/scripts/lib/file-lock.js (NOT this shim).

module.exports = require('../../../shared/file-lock');

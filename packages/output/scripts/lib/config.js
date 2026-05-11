// SHIM — source-tree only.
//
// Canonical implementation lives at packages/shared/config.js.
// At install time, the installer copies packages/shared/config.js directly
// to ~/.claude/scripts/lib/config.js (NOT this shim).

module.exports = require('../../../shared/config');

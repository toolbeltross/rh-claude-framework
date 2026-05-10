// SHIM — source-tree only.
//
// Canonical implementation lives at packages/shared/config.js.
// At install time, the installer copies packages/shared/config.js directly
// to ~/.claude/scripts/lib/config.js (NOT this shim).
//
// This shim exists so oversight scripts can keep using
//   require('./lib/config')
// and resolve correctly when run from source for tests / dev.

module.exports = require('../../../shared/config');

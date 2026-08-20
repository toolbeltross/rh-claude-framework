// SHIM — source-tree only.
//
// Canonical implementation lives at packages/shared/framework.js.
// At install time, the installer copies packages/shared/framework.js directly
// to ~/.claude/scripts/lib/framework.js (NOT this shim).
//
// This shim exists so scripts can keep using
//   require('./lib/framework')
// and resolve correctly when run from source for tests / dev.

module.exports = require('../../../shared/framework');

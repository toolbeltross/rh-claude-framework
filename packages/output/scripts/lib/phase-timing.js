// SHIM — source-tree only.
//
// Canonical implementation lives at packages/oversight/scripts/lib/phase-timing.js.
// Post-install, oversight's lib is copied to ~/.claude/scripts/lib/phase-timing.js
// and this shim is NOT shipped (output/install.json excludeSubdirs: ["lib"]).

module.exports = require('../../../oversight/scripts/lib/phase-timing');

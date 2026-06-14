// Test runner for @rh/output.

const path = require('path');

const SUITES = [
  'test-concurrent-write.js',
  'test-render-md-html.js',
  'test-generate-state-md.js',
  'test-scribe-table-write.js',
  'test-learnings-write.js',
  'test-auto-prune.js',
  'test-daily-regen-trigger.js',
  'test-daily-regen.js',
  'test-generate-env-md.js',
  'test-scribe-db.js',
  'test-transcript-ingest.js',
  'test-scribe-parity-audit.js',
];

let total = 0, failed = 0;
for (const suite of SUITES) {
  const { tests } = require(path.join(__dirname, suite));
  console.log(`\n  ${suite}`);
  for (const t of tests) {
    total++;
    try {
      t.fn();
      console.log(`    \x1b[32m✓\x1b[0m ${t.name}`);
    } catch (e) {
      failed++;
      console.log(`    \x1b[31m✗\x1b[0m ${t.name}`);
      console.log(`      ${e.message}`);
      if (process.env.VERBOSE) console.log(e.stack);
    }
  }
}

console.log(`\n  ${total - failed} passing, ${failed} failing\n`);
process.exit(failed > 0 ? 1 : 0);

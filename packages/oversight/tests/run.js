#!/usr/bin/env node
// Test runner for rh-claude-oversight. Uses node:assert, no external deps.

const path = require('path');
const fs = require('fs');

const TESTS_DIR = __dirname;
const tier = process.argv[2] || 'all';

const suites = [];
for (const f of fs.readdirSync(TESTS_DIR).sort()) {
  if (!f.startsWith('test-') || !f.endsWith('.js')) continue;
  const suiteTier = f.includes('integration') ? 'integration' : 'unit';
  if (tier !== 'all' && tier !== suiteTier) continue;
  suites.push({ file: f, tier: suiteTier, path: path.join(TESTS_DIR, f) });
}

let totalPass = 0;
let totalFail = 0;
const failures = [];

for (const suite of suites) {
  process.stdout.write(`\n  ${suite.file}\n`);
  try {
    const mod = require(suite.path);
    const tests = mod.tests || [];
    for (const t of tests) {
      try {
        t.fn();
        totalPass++;
        process.stdout.write(`    \x1b[32m✓\x1b[0m ${t.name}\n`);
      } catch (e) {
        totalFail++;
        failures.push({ suite: suite.file, test: t.name, error: e.message });
        process.stdout.write(`    \x1b[31m✗\x1b[0m ${t.name} — ${e.message}\n`);
      }
    }
  } catch (e) {
    totalFail++;
    failures.push({ suite: suite.file, test: '(load)', error: e.message });
    process.stdout.write(`    \x1b[31m✗\x1b[0m Failed to load: ${e.message}\n`);
  }
}

console.log(`\n  ${totalPass} passing, ${totalFail} failing\n`);

if (failures.length > 0) {
  console.log('  Failures:');
  for (const f of failures) console.log(`    ${f.suite} > ${f.test}: ${f.error}`);
  process.exit(1);
}

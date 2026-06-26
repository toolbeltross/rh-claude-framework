// Helper for test-cross-package-contract.js. Runs the real cross-package
// merge between rh-telemetry's buildHookConfig and rh-oversight's
// mergeHooksData in either order and emits the resulting settings.hooks
// object as JSON on stdout.
//
// Required because buildHookConfig is ESM-only and the oversight test
// runner is CJS. Spawning this as a node subprocess from the CJS test
// keeps the test file pattern consistent with the rest of the suite
// while still exercising the real ESM module.
//
// Usage: node run-cross-package-merge.mjs <scenario>
//   <scenario>: "oversight-first" | "telemetry-first"
//
// Exit 0 + JSON on stdout = success. Any error → stderr + exit 1.

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve as pathResolve } from 'path';
import { createRequire } from 'module';
import { buildHookConfig } from '../../../telemetry/scripts/setup-hooks.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

// CJS interop: oversight's lib/init.js exports mergeHooksData.
const { mergeHooksData } = require('../../lib/init.js');

const TEMPLATE_PATH = pathResolve(__dirname, '../../templates/settings.json.template');
const SCRIPTS_DIR_FAKE = '/tmp/test-home/.claude/scripts';
const OVERSIGHT_DIR_FAKE = '/tmp/test-home/oversight-system';

function loadOversightTemplateHooks() {
  const raw = readFileSync(TEMPLATE_PATH, 'utf8');
  const resolved = raw
    .replace(/\{\{SCRIPTS_DIR\}\}/g, SCRIPTS_DIR_FAKE)
    .replace(/\{\{OVERSIGHT_DIR\}\}/g, OVERSIGHT_DIR_FAKE);
  const parsed = JSON.parse(resolved);
  return parsed.hooks || {};
}

function applyOversight(existingSettings) {
  const oversightHooks = loadOversightTemplateHooks();
  const existingHooks = existingSettings.hooks || {};
  const merged = mergeHooksData(existingHooks, oversightHooks);
  return { ...existingSettings, hooks: merged };
}

function applyTelemetry(existingSettings) {
  return buildHookConfig(existingSettings);
}

function run() {
  const scenario = process.argv[2];
  if (!scenario || !['oversight-first', 'telemetry-first'].includes(scenario)) {
    console.error('Usage: run-cross-package-merge.mjs <oversight-first|telemetry-first>');
    process.exit(1);
  }

  let settings = {};
  if (scenario === 'oversight-first') {
    settings = applyOversight(settings);
    settings = applyTelemetry(settings);
  } else {
    settings = applyTelemetry(settings);
    settings = applyOversight(settings);
  }

  // Strip env section if telemetry added something — we only assert on hooks.
  process.stdout.write(JSON.stringify({ hooks: settings.hooks }, null, 2));
}

try {
  run();
} catch (e) {
  console.error(`run-cross-package-merge: ${e.stack || e.message}`);
  process.exit(1);
}

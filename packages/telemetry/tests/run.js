#!/usr/bin/env node
/**
 * Tiny test runner for rh-telemetry.
 *
 * Contract:
 *   - Every *.test.js file is run as its own child process.
 *   - Files report progress to stdout themselves.
 *   - A non-zero exit code from any file means that file failed.
 *   - The runner exits non-zero if any file failed.
 *
 * No test framework is needed — files use plain `node:assert` plus a small
 * `test()` helper (see tests/helpers/test-harness.js for one). Files that
 * already follow this pattern (like tests/unit/classifier.test.js) work as-is.
 *
 * Usage:
 *   node tests/run.js unit
 *   node tests/run.js integration
 *   node tests/run.js browser
 *   node tests/run.js              # runs unit + integration
 */
import { spawn } from 'child_process';
import { readdirSync, existsSync, statSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { sweepLeftoverTmps } from './helpers/tmp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

function listTests(dir) {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir);
  return entries
    .filter((name) => name.endsWith('.test.js'))
    .map((name) => join(dir, name))
    .filter((p) => statSync(p).isFile())
    .sort();
}

/**
 * Strip parent-shell env vars that would contaminate test fixtures.
 *
 * Verified 2026-04-25: when `CLAUDE_CONTEXT_WINDOW_SIZE=1000000` is set in the
 * parent shell (e.g., from `~/.claude/settings.json` env block), tests that
 * exercise `resolveContextWindowSize` and `updateLiveSession` fail because they
 * inherit the override. Conservative scrub: remove only the env vars proven to
 * affect test outcomes. Add to this list when new conflicts are discovered.
 */
const ENV_VARS_TO_SCRUB = [
  'CLAUDE_CONTEXT_WINDOW_SIZE', // affects context-window-size resolution tests
  'OVERSIGHT_LOG_PATH',          // dual-write target — could redirect log writes during integration tests
  'RH_TELEMETRY_PORT',       // could redirect server port
  'PORT',                        // generic port override
];

function cleanEnv() {
  const env = { ...process.env };
  for (const k of ENV_VARS_TO_SCRUB) delete env[k];
  // Force NODE_ENV=test so FailureStore's default-path guard redirects writes
  // to a tmp file even if a test forgets to pass one. Prevents the failure-log
  // pollution bug that the V2 sweepOrphanedSubagents test hit in 2026-05.
  env.NODE_ENV = 'test';
  return env;
}

function runFile(file) {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn('node', [file], {
      cwd: ROOT,
      stdio: 'inherit',
      env: cleanEnv(),
    });
    child.on('exit', (code) => {
      resolve({ file, code: code ?? 1, ms: Date.now() - start });
    });
    child.on('error', () => {
      resolve({ file, code: 1, ms: Date.now() - start });
    });
  });
}

async function runDir(name) {
  const dir = join(ROOT, 'tests', name);
  const files = listTests(dir);
  if (files.length === 0) {
    console.log(`${colors.dim}[${name}] no test files in ${dir}${colors.reset}`);
    return { passed: 0, failed: 0, files: 0, ms: 0 };
  }
  console.log(`${colors.cyan}[${name}] running ${files.length} file(s)${colors.reset}`);
  let passed = 0;
  let failed = 0;
  let totalMs = 0;
  for (const file of files) {
    const rel = file.replace(ROOT + '\\', '').replace(ROOT + '/', '').replace(/\\/g, '/');
    console.log(`${colors.dim}─── ${rel}${colors.reset}`);
    const result = await runFile(file);
    totalMs += result.ms;
    if (result.code === 0) {
      passed++;
    } else {
      failed++;
      console.log(`${colors.red}[${name}] FAIL ${rel} (exit ${result.code})${colors.reset}`);
    }
  }
  return { passed, failed, files: files.length, ms: totalMs };
}

async function main() {
  const args = process.argv.slice(2);
  // Default: unit + integration (skip browser — slower, opt-in)
  const targets = args.length > 0 ? args : ['unit', 'integration'];

  console.log(`\n${colors.cyan}rh-telemetry test runner${colors.reset}`);
  console.log(`${colors.dim}targets: ${targets.join(', ')}${colors.reset}\n`);

  // Sweep any leftover tmp dirs from a previously crashed test run
  sweepLeftoverTmps();

  let grandPassed = 0;
  let grandFailed = 0;
  let grandFiles = 0;
  let grandMs = 0;
  for (const target of targets) {
    const result = await runDir(target);
    grandPassed += result.passed;
    grandFailed += result.failed;
    grandFiles += result.files;
    grandMs += result.ms;
    console.log('');
  }

  const color = grandFailed > 0 ? colors.red : colors.green;
  console.log(`${color}${grandPassed}/${grandFiles} files passed${colors.reset} ${colors.dim}(${grandMs}ms total)${colors.reset}`);
  if (grandFailed > 0) {
    console.log(`${colors.red}${grandFailed} file(s) failed${colors.reset}`);
  }
  process.exit(grandFailed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[runner] crashed:', err);
  process.exit(1);
});

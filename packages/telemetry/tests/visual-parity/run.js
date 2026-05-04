#!/usr/bin/env node

/**
 * Visual Parity Test — compares Vite dev vs production build screenshots.
 *
 * Usage:
 *   node tests/visual-parity/run.js
 *   node tests/visual-parity/run.js --threshold 1.0
 *   node tests/visual-parity/run.js --skip-build
 *
 * Exit codes:
 *   0 = all views match within threshold
 *   1 = visual differences found or error
 */

import { spawn } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'net';

import { getFixtures } from './fixtures.js';
import { seedServer } from './seed.js';
import { captureViews } from './screenshot.js';
import { compareImages } from './diff.js';
import { generateReport } from './report.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const OUTPUT_DIR = join(__dirname, 'output');

import { PORT, VITE_DEV_PORT } from '../../server/config.js';

// Ports
const DEV_API_PORT = PORT;            // Express for dev (Vite proxies to this)
const PROD_PORT = PORT + 1;           // Express + static for prod
const VITE_PORT = VITE_DEV_PORT;      // Vite dev server

const children = [];

async function main() {
  const args = process.argv.slice(2);
  const skipBuild = args.includes('--skip-build');
  const thresholdArg = args.indexOf('--threshold');
  const threshold = thresholdArg >= 0 ? parseFloat(args[thresholdArg + 1]) : 0.5;

  console.log('\n=== Visual Parity Test ===\n');

  try {
    // 1. Check ports are free
    console.log('[1/8] Checking ports...');
    for (const port of [DEV_API_PORT, PROD_PORT, VITE_PORT]) {
      if (!(await isPortFree(port))) {
        throw new Error(`Port ${port} is in use. Stop any running servers and retry.`);
      }
    }
    console.log('  All ports free.\n');

    // 2. Build production bundle
    if (!skipBuild) {
      console.log('[2/8] Building production bundle...');
      await runCommand('npm', ['run', 'build'], { cwd: PROJECT_ROOT });
      console.log('  Build complete.\n');
    } else {
      console.log('[2/8] Skipping build (--skip-build).\n');
    }

    if (!existsSync(join(PROJECT_ROOT, 'dist', 'index.html'))) {
      throw new Error('dist/index.html not found. Run `npm run build` first.');
    }

    // 3. Start prod server (PORT=7891, NODE_ENV=production)
    console.log('[3/8] Starting production server on :' + PROD_PORT + '...');
    const prodProc = spawnServer('node', ['server/index.js'], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, PORT: String(PROD_PORT), NODE_ENV: 'production' },
    });
    children.push(prodProc);
    await waitForServer(`http://localhost:${PROD_PORT}/api/health`, 15000);
    console.log('  Prod server ready.\n');

    // 4. Start dev API server (PORT=7890)
    console.log('[4/8] Starting dev API server on :' + DEV_API_PORT + '...');
    const devApiProc = spawnServer('node', ['server/index.js'], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, PORT: String(DEV_API_PORT) },
    });
    children.push(devApiProc);
    await waitForServer(`http://localhost:${DEV_API_PORT}/api/health`, 15000);
    console.log('  Dev API server ready.\n');

    // 5. Start Vite dev server
    console.log('[5/8] Starting Vite dev server on :' + VITE_PORT + '...');
    const viteProc = spawnServer('npx', ['vite', '--port', String(VITE_PORT)], {
      cwd: PROJECT_ROOT,
      env: { ...process.env },
    });
    children.push(viteProc);
    await waitForServer(`http://127.0.0.1:${VITE_PORT}`, 20000);
    console.log('  Vite server ready.\n');

    // 6. Seed both servers with identical data
    console.log('[6/8] Seeding servers with fixture data...');
    const fixtures = getFixtures();
    // Dev: seed the API server directly (Vite proxies /api to :7890)
    await seedServer(`http://localhost:${DEV_API_PORT}`, fixtures);
    console.log('  Dev server seeded.');
    // Prod: seed directly
    await seedServer(`http://localhost:${PROD_PORT}`, fixtures);
    console.log('  Prod server seeded.');
    // Wait for WebSocket propagation
    await sleep(1500);
    console.log('');

    // 7. Capture screenshots
    console.log('[7/8] Capturing screenshots...');
    mkdirSync(OUTPUT_DIR, { recursive: true });
    const devScreenshots = await captureViews(`http://127.0.0.1:${VITE_PORT}`, OUTPUT_DIR, 'dev');
    const prodScreenshots = await captureViews(`http://localhost:${PROD_PORT}`, OUTPUT_DIR, 'prod');
    console.log('');

    // 8. Diff and report
    console.log('[8/8] Comparing screenshots...');
    const results = [];
    const views = ['session', 'overview', 'micro'];
    for (const view of views) {
      const devPath = join(OUTPUT_DIR, `dev-${view}.png`);
      const prodPath = join(OUTPUT_DIR, `prod-${view}.png`);
      if (existsSync(devPath) && existsSync(prodPath)) {
        const result = compareImages(devPath, prodPath, OUTPUT_DIR);
        results.push(result);
        const status = result.passed ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
        console.log(`  ${view}: ${status} (${result.diffPercent}% diff)`);
      } else {
        console.warn(`  ${view}: SKIP (missing screenshot)`);
      }
    }

    const reportPath = generateReport(results, OUTPUT_DIR);
    console.log(`\n  Report: ${reportPath}`);

    const allPassed = results.length > 0 && results.every(r => r.diffPercent < threshold);
    console.log(`\n${allPassed ? '\x1b[32m✓ All views match\x1b[0m' : '\x1b[31m✗ Visual differences found\x1b[0m'} (threshold: ${threshold}%)\n`);

    process.exitCode = allPassed ? 0 : 1;
  } catch (err) {
    console.error(`\n\x1b[31mError:\x1b[0m ${err.message}\n`);
    process.exitCode = 1;
  } finally {
    cleanup();
  }
}

// --- Utilities ---

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

function spawnServer(cmd, args, opts) {
  const proc = spawn(cmd, args, {
    ...opts,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  });
  // Suppress output unless debugging
  if (process.env.VP_DEBUG) {
    proc.stdout.on('data', (d) => process.stdout.write(`  [${cmd}] ${d}`));
    proc.stderr.on('data', (d) => process.stderr.write(`  [${cmd}] ${d}`));
  }
  proc.on('error', (err) => {
    console.error(`  [${cmd}] spawn error: ${err.message}`);
  });
  return proc;
}

async function waitForServer(url, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(url);
      if (resp.ok) return;
    } catch {
      // not ready yet
    }
    await sleep(500);
  }
  throw new Error(`Server at ${url} did not start within ${timeoutMs}ms`);
}

function runCommand(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { ...opts, stdio: 'inherit', shell: true });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
    });
    proc.on('error', reject);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanup() {
  for (const proc of children) {
    try {
      // On Windows, tree-kill the process group
      if (process.platform === 'win32') {
        spawn('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { shell: true, stdio: 'ignore' });
      } else {
        proc.kill('SIGTERM');
      }
    } catch {
      // already dead
    }
  }
}

// Handle interrupts
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

main();
/**
 * Shared test() helper used by *.test.js files.
 *
 * Tests are queued and run sequentially when summary() is called. This avoids
 * the foot-gun of async tests being dropped by a synchronous process.exit().
 *
 * Usage:
 *   import { test, summary } from '../helpers/test-harness.js';
 *   test('does the thing', () => { assert.strictEqual(1+1, 2); });
 *   test('does async thing', async () => { await something(); });
 *   summary();  // runs the queue, prints results, exits non-zero on failure
 */
const queue = [];
const teardowns = [];
let passed = 0;
let failed = 0;

const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  dim: '\x1b[2m',
};

export function test(name, fn) {
  queue.push({ name, fn });
}

/**
 * Register a teardown function that runs after all tests, before process.exit.
 * Useful for closing shared resources (e.g. Playwright browser instance).
 */
export function afterAll(fn) {
  teardowns.push(fn);
}

async function runOne({ name, fn }) {
  try {
    await fn();
    console.log(`  ${colors.green}✓${colors.reset} ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ${colors.red}✗${colors.reset} ${name}`);
    console.log(`    ${colors.red}${err.message}${colors.reset}`);
    if (err.stack) {
      console.log(`${colors.dim}${err.stack.split('\n').slice(1, 4).join('\n')}${colors.reset}`);
    }
    failed++;
  }
}

/**
 * Run the queued tests, print summary, exit. Safe to call without await —
 * but the calling file must NOT call process.exit before this resolves.
 */
export function summary() {
  // Wrap in an IIFE so we can use await without making the export async
  (async () => {
    for (const t of queue) {
      await runOne(t);
    }
    // Run teardowns in reverse-registration order
    for (let i = teardowns.length - 1; i >= 0; i--) {
      try {
        await teardowns[i]();
      } catch (err) {
        console.error(`[teardown] ${err.message}`);
      }
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  })();
}

/**
 * Wait for an EventEmitter to fire `eventName` (or matching predicate),
 * with timeout. Useful for store/broadcaster tests.
 */
export function assertEvent(emitter, eventName, { timeoutMs = 1000, predicate = null } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.removeListener(eventName, handler);
      reject(new Error(`Timeout waiting for "${eventName}" event after ${timeoutMs}ms`));
    }, timeoutMs);
    function handler(...args) {
      if (predicate && !predicate(...args)) return;
      clearTimeout(timer);
      emitter.removeListener(eventName, handler);
      resolve(args.length === 1 ? args[0] : args);
    }
    emitter.on(eventName, handler);
  });
}

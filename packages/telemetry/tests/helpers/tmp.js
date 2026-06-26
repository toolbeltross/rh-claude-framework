/**
 * Tmp directory helper. All tests that touch real filesystem state must
 * use this helper, never write to ~/.claude or any other live path.
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const PREFIX = 'ct-test-';

/** Create a fresh tmp directory and return its absolute path. */
export function makeTmp(label = '') {
  const prefix = label ? `${PREFIX}${label}-` : PREFIX;
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Recursively remove a tmp directory. Retries briefly on Windows where
 * antivirus / file indexers may hold a handle for a few hundred ms after
 * a child process exits.
 */
export function cleanupTmp(path) {
  if (!path || !existsSync(path)) return;
  let attempts = 5;
  while (attempts-- > 0) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return;
    } catch (err) {
      if (attempts === 0) {
        // Last attempt failed — log so the leftover is at least visible
        console.error(`[tmp] cleanup failed for ${path}: ${err.message}`);
        return;
      }
      // Sync sleep via Atomics — short, ~50ms
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); } catch {}
    }
  }
}

/**
 * Run `fn(tmpPath)` with guaranteed cleanup, even on throw.
 * Awaits async fns. Returns the fn's return value.
 */
export async function withTmp(fn, label = '') {
  const path = makeTmp(label);
  try {
    return await fn(path);
  } finally {
    cleanupTmp(path);
  }
}

/**
 * Build a fake HOME directory for spawning a server in isolation.
 * Creates ~/.claude/ inside the tmp dir and seeds settings.json from a fixture.
 *
 * @param {string} fixturePath - absolute path to a settings.json fixture
 * @returns {string} - the tmp HOME path (use as { HOME: ... } env override)
 */
export function makeFakeHome(fixturePath) {
  const home = makeTmp('home');
  const claudeDir = join(home, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  if (fixturePath && existsSync(fixturePath)) {
    const { readFileSync } = require('fs');
    writeFileSync(join(claudeDir, 'settings.json'), readFileSync(fixturePath, 'utf-8'));
  }
  return home;
}

/**
 * Sweep any leftover ct-test-* tmp directories. Call from runner startup
 * to clean up after a previously crashed test.
 */
export function sweepLeftoverTmps() {
  try {
    const entries = readdirSync(tmpdir());
    for (const name of entries) {
      if (name.startsWith(PREFIX)) {
        cleanupTmp(join(tmpdir(), name));
      }
    }
  } catch {
    // Ignore — best effort
  }
}

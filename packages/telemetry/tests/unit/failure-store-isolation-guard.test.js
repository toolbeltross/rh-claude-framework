/**
 * Unit tests for FailureStore's auto-redirect / alreadyIsolated guard.
 *
 * The guard logic lives in the constructor and depends on FAILURE_LOG_PATH,
 * which is computed at module-load time from process.env.HOME. To test the
 * different env scenarios cleanly, each scenario spawns a small Node subprocess
 * with controlled HOME + NODE_ENV that imports FailureStore, constructs one
 * without args, and prints the resulting filePath to stdout.
 *
 * What this guards (PR #27):
 *   - With NODE_ENV=test + HOME pointing to user real home → redirect to tmp
 *     (prevents pollution of the user's real ~/.claude/telemetry-failures.jsonl)
 *   - With NODE_ENV=test + HOME pointing INSIDE tmpdir already → leave alone
 *     (integration tests' explicit HOME=tmpdir isolation must be respected;
 *      overriding it would clobber paths the tests then read from)
 *   - Without NODE_ENV=test → use FAILURE_LOG_PATH directly
 *   - With RH_TELEMETRY_TEST_MODE=1 → same as NODE_ENV=test
 */

import assert from 'assert';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { test, summary } from '../helpers/test-harness.js';

console.log('failure-store isolation-guard tests:\n');

// Resolve absolute file:// URL to the failure-store module so the harness can
// import it from any cwd. ESM on Windows requires file:// URLs for absolute
// paths — `import 'C:/...'` throws ERR_UNSUPPORTED_ESM_URL_SCHEME.
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const FAILURE_STORE_URL = pathToFileURL(
  join(__dirname, '..', '..', 'server', 'failure-store.js')
).href;

const HARNESS_SRC = `
import { FailureStore } from '${FAILURE_STORE_URL}';
const s = new FailureStore();
process.stdout.write(s.filePath);
`;

function withTmpHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'fs-iso-'));
  // Pre-create .claude dir so the resolved FAILURE_LOG_PATH directory exists.
  mkdirSync(join(home, '.claude'), { recursive: true });
  try { return fn(home); }
  finally { rmSync(home, { recursive: true, force: true }); }
}

function spawnHarness(env) {
  // Write a tiny harness to a tmp file each call so we can control env independently.
  const harnessDir = mkdtempSync(join(tmpdir(), 'fs-iso-harness-'));
  const harnessPath = join(harnessDir, 'harness.mjs');
  writeFileSync(harnessPath, HARNESS_SRC, 'utf-8');
  try {
    const r = spawnSync(process.execPath, [harnessPath], {
      env: { ...env, RH_TELEMETRY_QUIET_TEST_REDIRECT: '1' },
      encoding: 'utf-8', timeout: 10000,
    });
    if (r.status !== 0) {
      throw new Error(`harness exited ${r.status}: ${r.stderr}`);
    }
    return r.stdout;
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
  }
}

test('NODE_ENV=test + HOME inside user-real-home → redirect to tmp', () => {
  // Use process.env.HOME (or USERPROFILE) — the actual user home, NOT inside tmpdir.
  const realHome = process.env.HOME || process.env.USERPROFILE;
  assert.ok(realHome, 'test requires a user home env var');
  assert.ok(!realHome.startsWith(tmpdir()), 'precondition: real home must not be inside tmpdir');

  const filePath = spawnHarness({
    HOME: realHome, USERPROFILE: realHome, NODE_ENV: 'test',
    PATH: process.env.PATH,
  });
  assert.ok(filePath.startsWith(tmpdir()),
    `expected redirect into tmpdir, got ${filePath}`);
  assert.ok(filePath.includes('rh-telemetry-failure-store-test'),
    `redirect path should include the marker: ${filePath}`);
});

test('NODE_ENV=test + HOME inside tmpdir → alreadyIsolated, leave path alone', () => {
  withTmpHome((home) => {
    const filePath = spawnHarness({
      HOME: home, USERPROFILE: home, NODE_ENV: 'test',
      PATH: process.env.PATH,
    });
    // Should resolve under home/.claude/, NOT to the global rh-telemetry-failure-store-test marker.
    const expected = join(home, '.claude', 'telemetry-failures.jsonl');
    assert.strictEqual(filePath, expected,
      `expected HOME-scoped path preserved, got ${filePath}`);
    assert.ok(!filePath.includes('rh-telemetry-failure-store-test'),
      'should NOT use the global redirect marker when already isolated');
  });
});

test('no NODE_ENV=test, no RH_TELEMETRY_TEST_MODE → use FAILURE_LOG_PATH directly', () => {
  withTmpHome((home) => {
    const env = {
      HOME: home, USERPROFILE: home,
      PATH: process.env.PATH,
    };
    delete env.NODE_ENV;
    delete env.RH_TELEMETRY_TEST_MODE;
    const filePath = spawnHarness(env);
    const expected = join(home, '.claude', 'telemetry-failures.jsonl');
    assert.strictEqual(filePath, expected);
  });
});

test('RH_TELEMETRY_TEST_MODE=1 + HOME inside user-real-home → redirect (same as NODE_ENV=test)', () => {
  const realHome = process.env.HOME || process.env.USERPROFILE;
  assert.ok(realHome && !realHome.startsWith(tmpdir()), 'precondition');

  const env = {
    HOME: realHome, USERPROFILE: realHome,
    RH_TELEMETRY_TEST_MODE: '1',
    PATH: process.env.PATH,
  };
  delete env.NODE_ENV;
  const filePath = spawnHarness(env);
  assert.ok(filePath.startsWith(tmpdir()),
    `expected redirect into tmpdir, got ${filePath}`);
});

test('RH_TELEMETRY_TEST_MODE=1 + HOME inside tmpdir → alreadyIsolated guard wins', () => {
  withTmpHome((home) => {
    const env = {
      HOME: home, USERPROFILE: home,
      RH_TELEMETRY_TEST_MODE: '1',
      PATH: process.env.PATH,
    };
    delete env.NODE_ENV;
    const filePath = spawnHarness(env);
    const expected = join(home, '.claude', 'telemetry-failures.jsonl');
    assert.strictEqual(filePath, expected);
  });
});

summary();

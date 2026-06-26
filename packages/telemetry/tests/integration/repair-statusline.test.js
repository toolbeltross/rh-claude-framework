/**
 * Integration tests for scripts/repair-statusline.js — spawns the CLI as a
 * child process with HOME=tmp so it operates against an isolated settings.json.
 */
import assert from 'assert';
import { spawnSync } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { test, summary } from '../helpers/test-harness.js';
import { withTmp } from '../helpers/tmp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..');
const REPAIR_CLI = join(PROJECT_ROOT, 'scripts', 'repair-statusline.js');
const FIXTURES = resolve(__dirname, '..', 'fixtures');

console.log('repair-statusline integration tests:\n');

function runRepair(home, args = []) {
  return spawnSync('node', [REPAIR_CLI, ...args], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf-8',
  });
}

function seedHome(home, fixtureName, scriptContent = null) {
  const claudeDir = join(home, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  let settingsContent = readFileSync(join(FIXTURES, `settings/${fixtureName}.json`), 'utf-8');

  if (scriptContent) {
    // Write the script and rewrite the placeholder marker in settings to point at it
    const scriptPath = join(claudeDir, 'fixture-script.js');
    writeFileSync(scriptPath, scriptContent);
    settingsContent = settingsContent.replace('REPLACE_ME_PLACEHOLDER_PATH', scriptPath.replace(/\\/g, '/'));
  }
  writeFileSync(join(claudeDir, 'settings.json'), settingsContent);
}

test('repair against placeholder fixture auto-upgrades and writes history', async () => {
  await withTmp(async (home) => {
    const placeholderScript = readFileSync(join(FIXTURES, 'settings/placeholder-script.js'), 'utf-8');
    seedHome(home, 'placeholder', placeholderScript);

    const result = runRepair(home);
    assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}\nstderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('placeholder'));
    assert.ok(result.stdout.includes('upgrade') || result.stdout.includes('upgraded'));

    const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8'));
    assert.ok(settings.statusLine.command.includes('hook-forwarder.js'));
    assert.ok(settings.statusLine.command.includes('status'));

    const historyPath = join(home, '.claude', 'telemetry-statusline-history.jsonl');
    assert.ok(existsSync(historyPath), 'history file should exist');
    const history = readFileSync(historyPath, 'utf-8').trim().split('\n');
    assert.strictEqual(history.length, 1);
    const entry = JSON.parse(history[0]);
    assert.strictEqual(entry.action, 'upgrade');
    assert.strictEqual(entry.classifier, 'placeholder');
  }, 'repair-placeholder');
});

test('repair is idempotent: second run reports healthy with no history append', async () => {
  await withTmp(async (home) => {
    seedHome(home, 'healthy');
    const result1 = runRepair(home);
    assert.strictEqual(result1.status, 0);
    assert.ok(result1.stdout.includes('healthy'));

    const result2 = runRepair(home);
    assert.strictEqual(result2.status, 0);
    assert.ok(result2.stdout.includes('healthy'));

    // History file should not exist (no rewrites happened)
    const historyPath = join(home, '.claude', 'telemetry-statusline-history.jsonl');
    assert.strictEqual(existsSync(historyPath), false);
  }, 'repair-idempotent');
});

test('repair against unknown-custom in non-TTY without --force: skip-noninteractive, no rewrite', async () => {
  await withTmp(async (home) => {
    seedHome(home, 'unknown-custom');
    const result = runRepair(home);
    assert.strictEqual(result.status, 0);
    assert.ok(result.stdout.includes('non-interactive') || result.stdout.includes('leaving unchanged'));

    // Settings unchanged
    const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8'));
    assert.strictEqual(settings.statusLine.command, 'node /tmp/totally-custom-statusline.js');
  }, 'repair-noninteractive');
});

test('repair --force replaces unknown-custom with telemetry forwarder', async () => {
  await withTmp(async (home) => {
    seedHome(home, 'unknown-custom');
    const result = runRepair(home, ['--force']);
    assert.strictEqual(result.status, 0);
    assert.ok(result.stdout.includes('replace'));

    const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8'));
    assert.ok(settings.statusLine.command.includes('hook-forwarder.js'));
  }, 'repair-force');
});

test('repair against missing settings creates settings + installs telemetry', async () => {
  await withTmp(async (home) => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: {} }));

    const result = runRepair(home);
    assert.strictEqual(result.status, 0);
    assert.ok(result.stdout.includes('install') || result.stdout.includes('missing'));

    const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8'));
    assert.ok(settings.statusLine);
    assert.ok(settings.statusLine.command.includes('hook-forwarder.js'));
  }, 'repair-missing');
});

summary();

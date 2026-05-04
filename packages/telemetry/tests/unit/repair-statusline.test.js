/**
 * Tests for scripts/repair-statusline.js — pure rewrite helpers.
 *
 * Full repair flow (with classifier branching, history append, etc.) is
 * exercised by tests/integration/repair-statusline.test.js via spawn.
 */
import assert from 'assert';
import { writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { test, summary } from '../helpers/test-harness.js';
import { withTmp } from '../helpers/tmp.js';
import { rewriteToTelemetry, rewriteToWrapper, TELEMETRY_COMMAND } from '../../scripts/repair-statusline.js';

console.log('repair-statusline (rewrite helpers) tests:\n');

test('rewriteToTelemetry: writes telemetry forwarder command', async () => {
  await withTmp(async (tmp) => {
    const settingsPath = join(tmp, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({
      statusLine: { type: 'command', command: 'node /old/path.js' },
      hooks: { Stop: [{ matcher: '*' }] },
    }));

    const result = rewriteToTelemetry(settingsPath);
    assert.strictEqual(result.previousCommand, 'node /old/path.js');
    assert.strictEqual(result.newCommand, TELEMETRY_COMMAND);

    const after = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    assert.strictEqual(after.statusLine.command, TELEMETRY_COMMAND);
    assert.strictEqual(after.statusLine.type, 'command');
    // Other keys preserved
    assert.deepStrictEqual(after.hooks, { Stop: [{ matcher: '*' }] });
  }, 'rewrite-tel');
});

test('rewriteToTelemetry: works with missing statusLine', async () => {
  await withTmp(async (tmp) => {
    const settingsPath = join(tmp, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ hooks: {} }));

    const result = rewriteToTelemetry(settingsPath);
    assert.strictEqual(result.previousCommand, '');
    assert.strictEqual(result.newCommand, TELEMETRY_COMMAND);

    const after = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    assert.ok(after.statusLine);
  }, 'rewrite-tel-missing');
});

test('rewriteToTelemetry: creates settings.json if file missing', async () => {
  await withTmp(async (tmp) => {
    const settingsPath = join(tmp, 'settings.json');
    // No file written — rewriteToTelemetry should treat it as empty settings
    const result = rewriteToTelemetry(settingsPath);
    assert.strictEqual(result.newCommand, TELEMETRY_COMMAND);
    const after = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    assert.strictEqual(after.statusLine.command, TELEMETRY_COMMAND);
  }, 'rewrite-tel-create');
});

test('rewriteToWrapper: writes node command pointing at wrapper', async () => {
  await withTmp(async (tmp) => {
    const settingsPath = join(tmp, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ statusLine: { command: 'node /old.js' } }));

    const wrapperPath = 'C:\\Users\\test\\.claude\\scripts\\statusline-wrapped.js';
    const result = rewriteToWrapper(wrapperPath, settingsPath);

    assert.strictEqual(result.previousCommand, 'node /old.js');
    // Backslashes normalized to forward slashes in the command string
    assert.ok(result.newCommand.includes('statusline-wrapped.js'));
    assert.ok(!result.newCommand.includes('\\'), 'should normalize backslashes to forward slashes');

    const after = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    assert.strictEqual(after.statusLine.command, result.newCommand);
  }, 'rewrite-wrap');
});

test('rewriteToWrapper: preserves other settings keys', async () => {
  await withTmp(async (tmp) => {
    const settingsPath = join(tmp, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({
      statusLine: { command: 'node /old.js' },
      env: { FOO: 'bar' },
      permissions: { allow: ['Bash(*)'] },
    }));

    rewriteToWrapper('/tmp/wrapper.js', settingsPath);

    const after = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    assert.deepStrictEqual(after.env, { FOO: 'bar' });
    assert.deepStrictEqual(after.permissions, { allow: ['Bash(*)'] });
  }, 'rewrite-wrap-preserve');
});

test('TELEMETRY_COMMAND points at hook-forwarder.js status', () => {
  assert.ok(TELEMETRY_COMMAND.includes('hook-forwarder.js'));
  assert.ok(TELEMETRY_COMMAND.includes('status'));
  assert.ok(TELEMETRY_COMMAND.startsWith('node '));
});

summary();

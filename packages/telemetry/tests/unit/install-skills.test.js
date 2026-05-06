/**
 * Tests for scripts/install-skills.js. Spawns the installer with an isolated
 * HOME so it writes into a tmp dir instead of the real ~/.claude/.
 *
 * Catches the failure class that broke /rh-telemetry repeatedly across renames:
 * the installer must (a) write SKILL.md to a path that matches the slash command,
 * (b) produce a CLI that is invokable end-to-end, and (c) self-test before exiting
 * success. If any of those break, this test fails in pre-commit instead of silently
 * in a user's next /rh-telemetry invocation.
 */
import assert from 'assert';
import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { test, summary } from '../helpers/test-harness.js';
import { withTmp } from '../helpers/tmp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..');
const INSTALLER = join(PROJECT_ROOT, 'scripts', 'install-skills.js');

console.log('install-skills tests:\n');

function runInstaller(tmpHome) {
  return spawnSync(process.execPath, [INSTALLER], {
    env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome },
    encoding: 'utf-8',
    timeout: 15_000,
  });
}

test('writes /rh-telemetry skill to ~/.claude/skills/rh-telemetry/ (matches slash command)', async () => {
  await withTmp(async (tmpHome) => {
    const r = runInstaller(tmpHome);
    assert.strictEqual(r.status, 0, `install failed: stdout=${r.stdout} stderr=${r.stderr}`);
    const skillDir = join(tmpHome, '.claude', 'skills', 'rh-telemetry');
    assert.ok(existsSync(join(skillDir, 'SKILL.md')), 'rh-telemetry/SKILL.md should exist');
    assert.ok(existsSync(join(skillDir, 'config.json')), 'rh-telemetry/config.json should exist');
    const oldDir = join(tmpHome, '.claude', 'skills', 'telemetry');
    assert.ok(!existsSync(oldDir), 'should NOT write to legacy telemetry/ path');
  }, 'install-skills-path');
});

test('SKILL.md frontmatter declares name: rh-telemetry and points at project CLI absolute path', async () => {
  await withTmp(async (tmpHome) => {
    const r = runInstaller(tmpHome);
    assert.strictEqual(r.status, 0, `install failed: ${r.stderr}`);
    const skillMd = readFileSync(
      join(tmpHome, '.claude', 'skills', 'rh-telemetry', 'SKILL.md'),
      'utf-8'
    );
    assert.ok(/^name: rh-telemetry$/m.test(skillMd), 'frontmatter name must be rh-telemetry');
    assert.ok(
      skillMd.includes(PROJECT_ROOT.replace(/\\/g, '/')),
      'SKILL.md must invoke the CLI via the project absolute path (no copy, no symlink)'
    );
  }, 'install-skills-skillmd');
});

test('self-test gate runs and prints "Self-test passed"', async () => {
  await withTmp(async (tmpHome) => {
    const r = runInstaller(tmpHome);
    assert.strictEqual(r.status, 0, `install failed: ${r.stderr}`);
    assert.ok(
      r.stdout.includes('Self-test passed'),
      `expected "Self-test passed" in stdout, got: ${r.stdout}`
    );
  }, 'install-skills-selftest');
});

test('also installs /rh-telemetry-setup with disable-model-invocation: true', async () => {
  await withTmp(async (tmpHome) => {
    const r = runInstaller(tmpHome);
    assert.strictEqual(r.status, 0, `install failed: ${r.stderr}`);
    const setupMd = readFileSync(
      join(tmpHome, '.claude', 'skills', 'rh-telemetry-setup', 'SKILL.md'),
      'utf-8'
    );
    assert.ok(/^name: rh-telemetry-setup$/m.test(setupMd), 'frontmatter name must be rh-telemetry-setup');
    assert.ok(/disable-model-invocation: true/.test(setupMd), 'setup skill must disable model invocation');
  }, 'install-skills-setupskill');
});

test('config.json records the live PROJECT_ROOT (not a stale npm path)', async () => {
  await withTmp(async (tmpHome) => {
    const r = runInstaller(tmpHome);
    assert.strictEqual(r.status, 0, `install failed: ${r.stderr}`);
    const cfg = JSON.parse(readFileSync(
      join(tmpHome, '.claude', 'skills', 'rh-telemetry', 'config.json'),
      'utf-8'
    ));
    assert.strictEqual(cfg.projectPath, PROJECT_ROOT, 'projectPath must be the live project root');
    assert.ok(cfg.installedAt, 'installedAt timestamp must be recorded');
    assert.ok(!cfg.projectPath.includes('claude-code-telemetry'), 'must not reference the old npm package name');
  }, 'install-skills-config');
});

summary();

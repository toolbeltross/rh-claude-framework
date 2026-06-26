#!/usr/bin/env node
/**
 * Configures Git to use the project-local .githooks/ directory for hooks.
 *
 * Idempotent — re-running just re-confirms the config. Run automatically by
 * `rh-telemetry setup`, or directly via `rh-telemetry install-git-hooks`.
 */
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const HOOKS_DIR = '.githooks';
const PRE_COMMIT = join(PROJECT_ROOT, HOOKS_DIR, 'pre-commit');

function isGitRepo() {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: PROJECT_ROOT,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

function getCurrentHooksPath() {
  try {
    const out = execFileSync('git', ['config', 'core.hooksPath'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return out.trim();
  } catch {
    return null;
  }
}

function setHooksPath(path) {
  execFileSync('git', ['config', 'core.hooksPath', path], { cwd: PROJECT_ROOT });
}

function main() {
  if (!isGitRepo()) {
    console.log('[git-hooks] not a git repository — skipping');
    process.exit(0);
  }

  if (!existsSync(PRE_COMMIT)) {
    console.error(`[git-hooks] pre-commit script not found at ${PRE_COMMIT}`);
    process.exit(1);
  }

  const current = getCurrentHooksPath();
  if (current === HOOKS_DIR) {
    console.log(`[git-hooks] already configured: core.hooksPath=${HOOKS_DIR}`);
    process.exit(0);
  }

  setHooksPath(HOOKS_DIR);
  console.log(`[git-hooks] set core.hooksPath=${HOOKS_DIR}`);
  console.log(`[git-hooks] pre-commit hook will run 'npm run test:unit' on every commit`);
  console.log(`[git-hooks] bypass with: git commit --no-verify`);
}

main();

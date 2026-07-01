/**
 * Tests for the rm root/home guard in scripts/env-rules.js DANGEROUS_PATTERNS.
 *
 * Regression: the original regex blocked ANY rm whose argument started with
 * `/` (e.g. `rm /c/Users/x/Temp/file.zip`) — two false positives observed
 * 2026-06-12. The guard must block rm targeting root / drive roots / home
 * directories THEMSELVES while allowing files and subdirectories under them.
 */
import assert from 'assert';
import { test, summary } from '../helpers/test-harness.js';
import { DANGEROUS_PATTERNS } from '../../scripts/env-rules.js';

console.log('rm-guard tests:\n');

const rmGuard = DANGEROUS_PATTERNS[0];
const blocked = (cmd) => rmGuard.test(cmd);

test('still blocks rm on root and drive roots', () => {
  assert.ok(blocked('rm -rf /'), 'rm -rf /');
  assert.ok(blocked('rm -rf /*'), 'rm -rf /*');
  assert.ok(blocked('rm -rf /c'), 'bare drive /c');
  assert.ok(blocked('rm -rf C:\\'), 'bare drive C:\\');
  assert.ok(blocked('rm -fr "C:/"'), 'quoted drive root, swapped flags');
});

test('still blocks rm on home directories and aliases', () => {
  assert.ok(blocked('rm -rf ~'), 'tilde');
  assert.ok(blocked('rm -rf ~/'), 'tilde slash');
  assert.ok(blocked('rm -rf $HOME'), '$HOME');
  assert.ok(blocked('rm -rf %USERPROFILE%'), '%USERPROFILE%');
  assert.ok(blocked('rm -rf /c/Users/testuser'), 'home via /c path');
  assert.ok(blocked('rm -rf "C:\\Users\\testuser"'), 'home via quoted Windows path');
  assert.ok(blocked('rm -rf /home/ross'), 'linux home');
  assert.ok(blocked('rm -rf /c/Users/testuser/*'), 'glob-everything under home');
  assert.ok(blocked('cd /tmp && rm -rf ~'), 'chained command');
});

test('allows rm on files and subdirectories under home (the false-positive class)', () => {
  assert.ok(!blocked('rm /c/Users/testuser/AppData/Local/Temp/chrome-win64.zip'), 'single file under home');
  assert.ok(!blocked('rm /c/Users/testuser/AppData/Local/Temp/a.zip /c/Users/testuser/AppData/Local/Temp/b.zip'), 'multiple files under home');
  assert.ok(!blocked('rm -rf /c/Users/testuser/AppData/Local/ms-playwright/chromium-1217'), 'recursive on a deep subdir');
  assert.ok(!blocked('rm -f /tmp/out.log'), 'tmp file');
  assert.ok(!blocked('rm file1.txt file2.txt'), 'relative files');
  assert.ok(!blocked('rm -rf node_modules'), 'relative dir');
  assert.ok(!blocked('rm -rf ./dist'), 'relative ./dir');
  assert.ok(!blocked('rm -rf ~/project/dist'), 'subdir under tilde');
});

test('non-rm commands never match this rule', () => {
  assert.ok(!blocked('echo rm -rf / is bad'), 'rm as argument text, echo is the command');
  assert.ok(!blocked('git rm cached-file.txt'), 'git rm');
  assert.ok(!blocked('npm run format'), 'unrelated');
});

test('blocks rm -rf / hidden by a newline or find -exec (evasion regressions)', () => {
  // A multi-line bash block put `rm -rf /` on its own line; the old single-line
  // ^ anchor missed it.
  assert.ok(blocked('echo hi\nrm -rf /'), 'newline-separated rm -rf /');
  assert.ok(blocked('cd /tmp\n  rm -rf ~'), 'newline + indent then rm ~');
  assert.ok(blocked('find . -exec rm -rf / \\;'), 'find -exec rm -rf /');
  // find -exec rm of the FOUND files (the {} placeholder) is legitimate.
  assert.ok(!blocked('find . -name "*.tmp" -exec rm -rf {} \\;'), 'find -exec rm of {} is allowed');
});

// ── settings.json clobber guard (DANGEROUS_PATTERNS[1]) ──────────────────────
const settingsGuard = DANGEROUS_PATTERNS[1];
const blockedSettings = (cmd) => settingsGuard.test(cmd);

test('blocks redirecting into settings.json under any path form (evasion regressions)', () => {
  assert.ok(blockedSettings('echo {} > ~/.claude/settings.json'), 'tilde redirect');
  assert.ok(blockedSettings('echo {} > $HOME/.claude/settings.json'), '$HOME redirect (was a bypass)');
  assert.ok(blockedSettings('echo {} >> /c/Users/x/.claude/settings.json'), 'absolute append (was a bypass)');
  assert.ok(blockedSettings('cat x > .claude\\settings.json'), 'relative + windows separator');
  assert.ok(!blockedSettings('cat ~/.claude/settings.json'), 'reading settings.json is fine (no redirect)');
});

summary();

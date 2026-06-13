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
  assert.ok(blocked('rm -rf /c/Users/rossb'), 'home via /c path');
  assert.ok(blocked('rm -rf "C:\\Users\\rossb"'), 'home via quoted Windows path');
  assert.ok(blocked('rm -rf /home/ross'), 'linux home');
  assert.ok(blocked('rm -rf /c/Users/rossb/*'), 'glob-everything under home');
  assert.ok(blocked('cd /tmp && rm -rf ~'), 'chained command');
});

test('allows rm on files and subdirectories under home (the false-positive class)', () => {
  assert.ok(!blocked('rm /c/Users/rossb/AppData/Local/Temp/chrome-win64.zip'), 'single file under home');
  assert.ok(!blocked('rm /c/Users/rossb/AppData/Local/Temp/a.zip /c/Users/rossb/AppData/Local/Temp/b.zip'), 'multiple files under home');
  assert.ok(!blocked('rm -rf /c/Users/rossb/AppData/Local/ms-playwright/chromium-1217'), 'recursive on a deep subdir');
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

summary();

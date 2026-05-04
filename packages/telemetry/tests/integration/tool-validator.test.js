#!/usr/bin/env node
/**
 * Integration test for tool-validator-v2.js
 *
 * Runs the validator as a child process (same as Claude Code hooks do)
 * and verifies it handles common false-positive commands correctly.
 *
 * Usage: node tests/integration/tool-validator.test.js
 */

import { execFile } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VALIDATOR = join(__dirname, '..', '..', 'scripts', 'tool-validator-v2.js');

/**
 * Run the validator with a given command string.
 * Returns { exitCode, stdout, stderr }.
 */
function runValidator(command) {
  return new Promise((resolve) => {
    const child = execFile('node', [VALIDATOR], { timeout: 5000 }, (err, stdout, stderr) => {
      resolve({
        exitCode: err ? err.code ?? 1 : 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
    // Send stdin JSON matching Claude Code hook format
    child.stdin.write(JSON.stringify({ tool_input: { command } }));
    child.stdin.end();
  });
}

// ─── Test cases ─────────────────────────────────────────────────────────────

const SHOULD_ALLOW = [
  // Package managers (were false-positived in Layer 2)
  'choco install gh -y',
  'winget install Git.Git',
  'apt install curl',
  'apt-get install -y build-essential',
  'brew install jq',
  'pip install requests',
  'pip3 install flask',
  'npm install -g typescript',
  'yarn add react',
  'cargo install ripgrep',

  // Standard dev commands
  'git status',
  'git log --oneline -10',
  'npm run build',
  'node server/index.js',
  'docker ps',
  'curl -s http://localhost:7890/api/health',
  'mkdir -p src/components',
  'ls -la',
  'which node',
  'python3 -c "print(1)"',

  // PowerShell wrappers
  'powershell.exe -Command "Get-Process"',
  'pwsh.exe -NoProfile -Command "Test-Path foo"',

  // Piped data processing (awk/sed in pipes are fine)
  'echo hello | sed s/hello/world/',
  'cat file.txt | awk "{print $1}" | sort',

  // echo/printf without redirect
  'echo "hello world"',
  'printf "%s\\n" "test"',

  // tail -f (following is legitimate)
  'tail -f /var/log/syslog',

  // find with -exec (action, not search)
  'find . -name "*.tmp" -exec rm {} \\;',

  // cat with heredoc or /dev/null
  'cat <<EOF > file.txt',
  'cat /dev/null > output.log',
];

const SHOULD_SUGGEST = [
  // Wrong-tool patterns (should get contextAddition, NOT block)
  { cmd: 'cat package.json', pattern: 'Read tool' },
  { cmd: 'head -20 src/App.jsx', pattern: 'Read tool' },
  { cmd: 'tail -5 README.md', pattern: 'Read tool' },
  { cmd: 'grep -r "TODO" src/', pattern: 'Grep tool' },
  { cmd: 'rg "import" --type js', pattern: 'Grep tool' },
  { cmd: 'find . -name "*.js"', pattern: 'Glob tool' },
  { cmd: 'sed -i "s/old/new/g" file.txt', pattern: 'Edit tool' },
  { cmd: 'echo "content" > output.txt', pattern: 'Write tool' },
  { cmd: 'printf "data" > file.txt', pattern: 'Write tool' },
];

const SHOULD_BLOCK = [
  // Genuinely dangerous (exit 2)
  { cmd: 'rm -rf /', pattern: 'BLOCKED' },
  { cmd: 'rm -rf ~', pattern: 'BLOCKED' },
  { cmd: 'echo "{}" > ~/.claude/settings.json', pattern: 'BLOCKED' },
  { cmd: 'chmod 777 /', pattern: 'BLOCKED' },
  { cmd: 'dd if=/dev/zero of=/dev/sda', pattern: 'BLOCKED' },
];

// ─── Runner ─────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(label, cmd, expectation) {
  const result = await runValidator(cmd);

  let ok = false;
  let detail = '';

  switch (expectation.type) {
    case 'allow':
      ok = result.exitCode === 0 && !result.stdout;
      detail = ok ? '' : `exit=${result.exitCode}, stdout="${result.stdout}", stderr="${result.stderr}"`;
      break;
    case 'suggest':
      ok = result.exitCode === 0 && result.stdout.includes(expectation.pattern);
      detail = ok ? '' : `exit=${result.exitCode}, stdout="${result.stdout}" (expected "${expectation.pattern}")`;
      break;
    case 'block':
      ok = result.exitCode === 2;
      detail = ok ? '' : `exit=${result.exitCode}, stderr="${result.stderr}" (expected exit 2)`;
      break;
  }

  if (ok) {
    passed++;
  } else {
    failed++;
    console.log(`  FAIL: ${label}`);
    console.log(`        cmd: ${cmd}`);
    console.log(`        ${detail}`);
  }
}

async function main() {
  console.log('Tool Validator v2 — Integration Tests\n');

  console.log('--- SHOULD ALLOW (exit 0, no stdout) ---');
  for (const cmd of SHOULD_ALLOW) {
    await test(`allow: ${cmd}`, cmd, { type: 'allow' });
  }

  console.log('--- SHOULD SUGGEST (exit 0, contextAddition) ---');
  for (const { cmd, pattern } of SHOULD_SUGGEST) {
    await test(`suggest: ${cmd}`, cmd, { type: 'suggest', pattern });
  }

  console.log('--- SHOULD BLOCK (exit 2) ---');
  for (const { cmd, pattern } of SHOULD_BLOCK) {
    await test(`block: ${cmd}`, cmd, { type: 'block', pattern });
  }

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();

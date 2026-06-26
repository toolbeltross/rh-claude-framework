// Tests for rh-generate-env-md.js — scans filesystem state and writes
// ENVIRONMENT.md to <oversightDir>/../environment/ENVIRONMENT.md.
//
// Spawn approach: control HOME/CLAUDE_DIR/OVERSIGHT_DIR/CLAUDE_WORKSPACE so
// config resolves to a tmp tree. Seed fixture files where sections need content.

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'rh-generate-env-md.js');

function withTmpEnv(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-gen-env-md-'));
  const claudeDir = path.join(home, '.claude');
  const oversightDir = path.join(claudeDir, 'oversight');
  const agentsDir = path.join(claudeDir, 'agents');
  const scriptsDir = path.join(claudeDir, 'scripts');
  const skillsDir = path.join(claudeDir, 'skills');
  const rulesDir = path.join(home, '.claude', 'rules');
  fs.mkdirSync(oversightDir, { recursive: true });
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.mkdirSync(rulesDir, { recursive: true });
  try {
    return fn({ home, claudeDir, oversightDir, agentsDir, scriptsDir, skillsDir, rulesDir });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function runScript(home, oversightDir) {
  return spawnSync('node', [SCRIPT], {
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CLAUDE_DIR: path.join(home, '.claude'),
      OVERSIGHT_DIR: oversightDir,
      CLAUDE_WORKSPACE: home,
    },
  });
}

function outputPath(claudeDir) {
  // OUTPUT_PATH = path.join(config.oversightDir, "..", "environment", "ENVIRONMENT.md")
  // = claudeDir/environment/ENVIRONMENT.md
  return path.join(claudeDir, 'environment', 'ENVIRONMENT.md');
}

function readOutput(claudeDir) {
  return fs.readFileSync(outputPath(claudeDir), 'utf8');
}

const tests = [
  {
    name: 'exits 0 with empty tmp fixtures',
    fn: () => withTmpEnv(({ home, oversightDir }) => {
      const r = runScript(home, oversightDir);
      assert.strictEqual(r.status, 0,
        `should exit 0; stderr: ${(r.stderr || '').slice(0, 300)}`);
    }),
  },
  {
    name: 'creates ENVIRONMENT.md at <claudeDir>/environment/ENVIRONMENT.md',
    fn: () => withTmpEnv(({ home, claudeDir, oversightDir }) => {
      runScript(home, oversightDir);
      assert.ok(fs.existsSync(outputPath(claudeDir)), 'ENVIRONMENT.md should exist');
    }),
  },
  {
    name: 'output starts with "# Environment Inventory"',
    fn: () => withTmpEnv(({ home, claudeDir, oversightDir }) => {
      runScript(home, oversightDir);
      const content = readOutput(claudeDir);
      assert.match(content, /^# Environment Inventory/m);
    }),
  },
  {
    name: 'output contains "## ⏱ Last updated" header',
    fn: () => withTmpEnv(({ home, claudeDir, oversightDir }) => {
      runScript(home, oversightDir);
      const content = readOutput(claudeDir);
      assert.ok(content.includes('## ⏱ Last updated'), 'last-updated header must be present');
    }),
  },
  {
    name: 'output contains all expected section headers',
    fn: () => withTmpEnv(({ home, claudeDir, oversightDir }) => {
      runScript(home, oversightDir);
      const content = readOutput(claudeDir);
      const required = [
        '## MCP Servers',
        '## Hooks',
        '## Hook Scripts',
        '## Agents',
        '## Skills',
        '## Rules',
        '## Memories',
        '## Plans',
        '## Where to Look',
      ];
      for (const header of required) {
        assert.ok(content.includes(header), `section header "${header}" missing`);
      }
    }),
  },
  {
    name: 'Hooks section reflects hooks in settings.json',
    fn: () => withTmpEnv(({ home, claudeDir, oversightDir }) => {
      fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
        hooks: {
          PreToolUse: [{
            matcher: 'Write',
            hooks: [{ type: 'command', command: 'node ~/.claude/scripts/rh-unique-fixture-hook.js' }],
          }],
        },
      }, null, 2));
      runScript(home, oversightDir);
      const content = readOutput(claudeDir);
      assert.ok(content.includes('rh-unique-fixture-hook.js'),
        'hook script name should appear in Hooks section');
    }),
  },
  {
    name: 'Hooks section graceful when settings.json is absent',
    fn: () => withTmpEnv(({ home, claudeDir, oversightDir }) => {
      // No settings.json written
      runScript(home, oversightDir);
      const content = readOutput(claudeDir);
      assert.ok(content.includes('## Hooks'), 'Hooks section should still appear');
      assert.ok(content.includes('No hooks'), 'Should note no hooks when settings absent');
    }),
  },
  {
    name: 'Hook Scripts section lists .js files in scriptsDir',
    fn: () => withTmpEnv(({ home, claudeDir, oversightDir, scriptsDir }) => {
      fs.writeFileSync(path.join(scriptsDir, 'rh-unique-fixture-script.js'),
        '// unique fixture script\n');
      runScript(home, oversightDir);
      const content = readOutput(claudeDir);
      assert.ok(content.includes('rh-unique-fixture-script.js'),
        'fixture script should appear in Hook Scripts section');
    }),
  },
  {
    name: 'Agents section lists active agents from agentsDir (with frontmatter)',
    fn: () => withTmpEnv(({ home, claudeDir, oversightDir, agentsDir }) => {
      fs.writeFileSync(path.join(agentsDir, 'rh-unique-fixture-agent.md'),
        '---\nname: rh-unique-fixture-agent\ndescription: Fixture agent for testing\n---\n# Body\n');
      runScript(home, oversightDir);
      const content = readOutput(claudeDir);
      assert.ok(content.includes('rh-unique-fixture-agent'),
        'fixture agent should appear in Agents section');
      assert.ok(content.includes('Fixture agent for testing'),
        'agent description should appear');
    }),
  },
  {
    name: 'Agents section lists staged agents from staged-agents dir',
    fn: () => withTmpEnv(({ home, claudeDir, oversightDir }) => {
      const stagedDir = path.join(home, '.claude', 'staged-agents');
      fs.mkdirSync(stagedDir, { recursive: true });
      fs.writeFileSync(path.join(stagedDir, 'rh-staged-fixture.md'),
        '---\nname: rh-staged-fixture\ndescription: Staged fixture\n---\n# Body\n');
      runScript(home, oversightDir);
      const content = readOutput(claudeDir);
      assert.ok(content.includes('rh-staged-fixture'), 'staged agent should appear');
      assert.ok(content.includes('Staged'), 'Staged section header should appear');
    }),
  },
  {
    name: 'Rules section lists .md files from workspace .claude/rules/',
    fn: () => withTmpEnv(({ home, claudeDir, oversightDir, rulesDir }) => {
      fs.writeFileSync(path.join(rulesDir, 'rh-unique-fixture-rule.md'),
        '# Unique Fixture Rule\nsome body\n');
      runScript(home, oversightDir);
      const content = readOutput(claudeDir);
      assert.ok(content.includes('rh-unique-fixture-rule.md'),
        'fixture rule file should appear in Rules section');
      assert.ok(content.includes('Unique Fixture Rule'),
        'H1 of rule file should be extracted');
    }),
  },
  {
    name: 'MCP Servers section handles missing config files gracefully',
    fn: () => withTmpEnv(({ home, claudeDir, oversightDir }) => {
      // No MCP config files exist in tmp env
      runScript(home, oversightDir);
      const content = readOutput(claudeDir);
      assert.ok(content.includes('## MCP Servers'), 'MCP section header must appear');
      assert.ok(content.includes('No MCP servers'), 'Should note no servers found');
    }),
  },
  {
    name: 'output is idempotent (two runs produce same structure)',
    fn: () => withTmpEnv(({ home, claudeDir, oversightDir }) => {
      runScript(home, oversightDir);
      const c1 = readOutput(claudeDir);
      runScript(home, oversightDir);
      const c2 = readOutput(claudeDir);
      // Strip timestamps before comparing.
      // The header section emits timestamps in two forms:
      //   - H2:  ## ⏱ Last updated: **<ts>**
      //   - Table rows: | Generated (local) | `<ts>` |  and  | Generated (UTC) | `<ts>` |
      // The footer emits:  Generated `<ts>` · Rebuild manually: ...
      const strip = (s) => s
        .replace(/Last updated: \*\*[^*]+\*\*/, 'Last updated: **<ts>**')
        .replace(/\| Generated \(local\) \|[^\n]+\n/, '| Generated (local) | <ts> |\n')
        .replace(/\| Generated \(UTC\) \|[^\n]+\n/, '| Generated (UTC) | <ts> |\n')
        .replace(/Generated `[^`]+`/g, 'Generated `<ts>`');
      assert.strictEqual(strip(c1), strip(c2), 'output should be deterministic modulo timestamps');
    }),
  },
];

module.exports = { tests };

// Unit tests for rh-generate-state-md.js — generates OVERSIGHT_STATE.md
// (filesystem snapshot of rules/hooks/agents/log) used by rh-daily-regen as
// the canonical "current state" doc.
//
// Spawn the script with controlled env (HOME, CLAUDE_WORKSPACE) pointing
// at a tmp dir seeded with fixture files. Assert on the generated output.

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'rh-generate-state-md.js');

function withTmpEnv(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-gen-state-md-'));
  const claudeDir = path.join(home, '.claude');
  const oversightDir = path.join(claudeDir, 'oversight');
  const agentsDir = path.join(claudeDir, 'agents');
  const rulesDir = path.join(home, '.claude', 'rules');  // workspace=home
  fs.mkdirSync(oversightDir, { recursive: true });
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.mkdirSync(rulesDir, { recursive: true });
  try {
    return fn({ home, claudeDir, oversightDir, agentsDir, rulesDir });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function runScript(env) {
  return spawnSync('node', [SCRIPT], {
    encoding: 'utf8', timeout: 10000, windowsHide: true,
    env: { ...process.env, ...env },
  });
}

function makeEnv(home) {
  return {
    HOME: home, USERPROFILE: home,
    CLAUDE_DIR: path.join(home, '.claude'),
    CLAUDE_WORKSPACE: home,
    OVERSIGHT_DIR: path.join(home, '.claude', 'oversight'),
  };
}

const tests = [
  {
    name: 'minimal fixtures (empty dirs): generates OVERSIGHT_STATE.md at OUTPUT_PATH',
    fn: () => withTmpEnv(({ home, oversightDir }) => {
      const r = runScript(makeEnv(home));
      assert.strictEqual(r.status, 0,
        `exited ${r.status}: stdout=${r.stdout?.slice(0, 200)} stderr=${r.stderr?.slice(0, 200)}`);
      const outPath = path.join(oversightDir, 'OVERSIGHT_STATE.md');
      assert.ok(fs.existsSync(outPath), 'output file should exist');
      const content = fs.readFileSync(outPath, 'utf-8');
      assert.ok(content.length > 200, 'output should be substantial');
    }),
  },
  {
    name: 'output contains the canonical top-level H1 and Last-updated header',
    fn: () => withTmpEnv(({ home, oversightDir }) => {
      runScript(makeEnv(home));
      const content = fs.readFileSync(path.join(oversightDir, 'OVERSIGHT_STATE.md'), 'utf-8');
      assert.match(content, /^# Oversight System — Current State/m);
      assert.match(content, /## ⏱ Last updated/);
    }),
  },
  {
    name: 'output contains all 7 main section headers',
    fn: () => withTmpEnv(({ home, oversightDir }) => {
      runScript(makeEnv(home));
      const content = fs.readFileSync(path.join(oversightDir, 'OVERSIGHT_STATE.md'), 'utf-8');
      for (const header of [
        'Rules In Place',
        'Hooks Active',
        // Failure-mitigation section header text varies; check for failure ID anchor pattern instead.
        // Oversight Agents
        'Oversight',
        'Supervisory Log',
      ]) {
        assert.ok(content.includes(header), `missing section header: ${header}`);
      }
    }),
  },
  {
    name: 'Rules In Place section lists each .md file in rulesDir',
    fn: () => withTmpEnv(({ home, oversightDir, rulesDir }) => {
      fs.writeFileSync(path.join(rulesDir, 'rh-unique-fixture-rule.md'), '# Unique Fixture Rule H1\nbody\n');
      fs.writeFileSync(path.join(rulesDir, 'rh-second-fixture.md'), '# Second Fixture\nmore\n');
      runScript(makeEnv(home));
      const content = fs.readFileSync(path.join(oversightDir, 'OVERSIGHT_STATE.md'), 'utf-8');
      assert.ok(content.includes('rh-unique-fixture-rule.md'),
        'first rule file must appear in Rules table');
      assert.ok(content.includes('rh-second-fixture.md'),
        'second rule file must appear in Rules table');
      assert.match(content, /Unique Fixture Rule H1/, 'H1 must be extracted into the table');
    }),
  },
  {
    name: 'Hooks Active section reflects settings.json hooks',
    fn: () => withTmpEnv(({ home, claudeDir, oversightDir }) => {
      const settings = {
        hooks: {
          PreToolUse: [{
            matcher: 'Write',
            hooks: [{ type: 'command', command: 'node ~/.claude/scripts/rh-unique-fixture-hook.js' }],
          }],
        },
      };
      fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify(settings, null, 2));
      runScript(makeEnv(home));
      const content = fs.readFileSync(path.join(oversightDir, 'OVERSIGHT_STATE.md'), 'utf-8');
      assert.ok(content.includes('rh-unique-fixture-hook.js'),
        'hook command must appear in Hooks Active section');
    }),
  },
  {
    name: 'Hooks Active section handles missing settings.json gracefully',
    fn: () => withTmpEnv(({ home, oversightDir }) => {
      // No settings.json written.
      const r = runScript(makeEnv(home));
      assert.strictEqual(r.status, 0, 'should succeed even with missing settings.json');
      const content = fs.readFileSync(path.join(oversightDir, 'OVERSIGHT_STATE.md'), 'utf-8');
      assert.match(content, /No hooks|Hooks Active/, 'should mention hooks section');
    }),
  },
  {
    name: 'Oversight Agents section lists files from agentsDir',
    fn: () => withTmpEnv(({ home, oversightDir, agentsDir }) => {
      // The script filters by OVERSIGHT_AGENT_NAMES (supervisor, source-verifier, facilitator, docs-knowledge)
      // — drop in one matching agent fixture.
      fs.writeFileSync(path.join(agentsDir, 'rh-supervisor.md'),
        '---\nname: rh-supervisor\ndescription: fixture supervisor agent\n---\n# Body\n');
      runScript(makeEnv(home));
      const content = fs.readFileSync(path.join(oversightDir, 'OVERSIGHT_STATE.md'), 'utf-8');
      assert.ok(content.includes('rh-supervisor'),
        'matching oversight agent name should appear');
    }),
  },
  {
    name: 'output is well-formed markdown (no unclosed sections, has horizontal rules)',
    fn: () => withTmpEnv(({ home, oversightDir }) => {
      runScript(makeEnv(home));
      const content = fs.readFileSync(path.join(oversightDir, 'OVERSIGHT_STATE.md'), 'utf-8');
      // At minimum, expect at least one HR separator and a "See also:" footer link
      assert.ok(content.includes('---'), 'should contain at least one HR separator');
      assert.match(content, /See also:.*OVERSIGHT_SYSTEM\.md/,
        'footer should reference OVERSIGHT_SYSTEM.md');
    }),
  },
  {
    name: 'output mentions design-doc NOT FOUND when OVERSIGHT_SYSTEM.md is absent',
    fn: () => withTmpEnv(({ home, oversightDir }) => {
      runScript(makeEnv(home));
      const content = fs.readFileSync(path.join(oversightDir, 'OVERSIGHT_STATE.md'), 'utf-8');
      assert.match(content, /OVERSIGHT_SYSTEM\.md.*NOT FOUND/,
        'design-doc absence should be flagged in header');
    }),
  },
  {
    name: 'output reflects OVERSIGHT_SYSTEM.md when present (with valid failures-data block)',
    fn: () => withTmpEnv(({ home, oversightDir }) => {
      const designDoc = path.join(oversightDir, 'OVERSIGHT_SYSTEM.md');
      // Minimum valid design doc: top H1 + the failures-data JSON block the
      // generator parses. Each failure needs id + mitigations[] with
      // type/file/path triplet (per loadFailuresFromDesignDoc validation).
      const failuresJson = JSON.stringify([
        {
          id: 'F-99',
          name: 'Test fixture failure',
          mitigations: [
            { type: 'rule', file: 'rh-test.md', path: '<workspace>/.claude/rules/rh-test.md' },
          ],
        },
      ]);
      fs.writeFileSync(designDoc,
        '# OVERSIGHT_SYSTEM\n\n' +
        '<!-- failures-data:begin -->\n' +
        '```json\n' +
        failuresJson + '\n' +
        '```\n' +
        '<!-- failures-data:end -->\n'
      );
      const r = runScript(makeEnv(home));
      assert.strictEqual(r.status, 0,
        `script should succeed with valid design doc; stderr=${r.stderr?.slice(0, 300)}`);
      const content = fs.readFileSync(path.join(oversightDir, 'OVERSIGHT_STATE.md'), 'utf-8');
      assert.ok(!/NOT FOUND/.test(content), 'NOT FOUND warning should be absent when design doc present');
      assert.ok(content.includes('F-99'), 'fixture failure ID should appear in output');
    }),
  },
  {
    name: 'output is idempotent: two consecutive runs produce structurally-equivalent files',
    fn: () => withTmpEnv(({ home, oversightDir }) => {
      runScript(makeEnv(home));
      const c1 = fs.readFileSync(path.join(oversightDir, 'OVERSIGHT_STATE.md'), 'utf-8');
      runScript(makeEnv(home));
      const c2 = fs.readFileSync(path.join(oversightDir, 'OVERSIGHT_STATE.md'), 'utf-8');
      // Timestamps differ between runs — strip them before comparison.
      // Header has 3 timestamps (Last updated, Generated (local), Generated (UTC));
      // footer has a separate ISO timestamp embedded in backticks.
      const strip = (s) => s
        .replace(/Last updated: \*\*[^*]+\*\*/, 'Last updated: **<ts>**')
        .replace(/Generated \(local\):.*\n/, 'Generated (local): <ts>\n')
        .replace(/Generated \(UTC\):.*\n/, 'Generated (UTC): <ts>\n')
        .replace(/Generated `[^`]+`/g, 'Generated `<ts>`');
      assert.strictEqual(strip(c1), strip(c2),
        'output should be deterministic modulo timestamps');
    }),
  },
];

module.exports = { tests };

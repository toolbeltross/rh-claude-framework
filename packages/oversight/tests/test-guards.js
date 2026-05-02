// Unit tests for oversight guard scripts — feed payloads, check exit codes and JSON output.

const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');

const SCRIPTS_DIR = path.join(__dirname, '..', 'scripts');

function runHook(scriptName, stdinObj) {
  const input = typeof stdinObj === 'string' ? stdinObj : JSON.stringify(stdinObj);
  const r = spawnSync('node', [path.join(SCRIPTS_DIR, scriptName)], {
    input, encoding: 'utf8', timeout: 5000, windowsHide: true,
    env: { ...process.env, OVERSIGHT_SELF_TEST: '1' },
  });
  return { exitCode: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function parseOutput(r) {
  assert.strictEqual(r.exitCode, 0, `hook exited ${r.exitCode}: ${r.stderr.slice(0, 200)}`);
  return JSON.parse(r.stdout || '{}');
}

const tests = [
  {
    name: 'consolidation-guard blocks MASTER_ file without registry',
    fn: () => {
      const r = runHook('rh-consolidation-guard.js', {
        tool_input: { file_path: '/tmp/MASTER_TEST.md', content: 'No registry here.' }
      });
      const out = parseOutput(r);
      assert.strictEqual(out.decision, 'block');
    },
  },
  {
    name: 'consolidation-guard allows non-consolidation file',
    fn: () => {
      const r = runHook('rh-consolidation-guard.js', {
        tool_input: { file_path: '/tmp/notes.md', content: 'Just notes.' }
      });
      const out = parseOutput(r);
      assert.strictEqual(out.decision, 'allow');
    },
  },
  {
    name: 'consolidation-guard allows consolidation file WITH registry',
    fn: () => {
      const r = runHook('rh-consolidation-guard.js', {
        tool_input: {
          file_path: '/tmp/MASTER_DOC.md',
          content: '# Source Registry\n| file | verification token | first line |\n|---|---|---|'
        }
      });
      const out = parseOutput(r);
      assert.strictEqual(out.decision, 'allow');
    },
  },
  {
    name: 'agent-oversight-guard injects block when missing',
    fn: () => {
      const r = runHook('rh-agent-oversight-guard.js', {
        tool_input: { prompt: 'Read a file', description: 'test', subagent_type: 'general-purpose' }
      });
      const out = parseOutput(r);
      const updated = out?.hookSpecificOutput?.updatedInput?.prompt || '';
      assert.ok(/Required oversight block/i.test(updated), 'should inject oversight block');
    },
  },
  {
    name: 'agent-oversight-guard passes when block present',
    fn: () => {
      const r = runHook('rh-agent-oversight-guard.js', {
        tool_input: {
          prompt: 'verification token first line verbatim. compactions and % used. batch overflow STOP and return remaining count.',
          description: 'test', subagent_type: 'general-purpose'
        }
      });
      const out = parseOutput(r);
      assert.ok(!out.hookSpecificOutput, 'should not inject when all elements present');
    },
  },
  {
    name: 'agent-result-guard detects zero-source pattern',
    fn: () => {
      const r = runHook('rh-agent-result-guard.js', {
        tool_input: { description: 'test' },
        tool_output: 'Sources found: 0. Successfully processed: 0.'
      });
      const out = parseOutput(r);
      assert.strictEqual(out.decision, 'block');
    },
  },
  {
    name: 'agent-result-guard passes clean output',
    fn: () => {
      const r = runHook('rh-agent-result-guard.js', {
        tool_input: { description: 'test' },
        tool_output: 'Found 5 sources, processed 5, failures: 0. Context: 18%.'
      });
      const out = parseOutput(r);
      assert.ok(out.decision !== 'block', 'should not block clean output');
    },
  },
  // Robustness: malformed input should not crash
  {
    name: 'consolidation-guard handles empty stdin',
    fn: () => {
      const r = runHook('rh-consolidation-guard.js', '');
      assert.strictEqual(r.exitCode, 0, 'should not crash on empty stdin');
    },
  },
  {
    name: 'agent-oversight-guard handles garbage JSON',
    fn: () => {
      const r = runHook('rh-agent-oversight-guard.js', 'this is not JSON');
      assert.strictEqual(r.exitCode, 0, 'should not crash on garbage');
    },
  },
  {
    name: 'agent-result-guard handles truncated JSON',
    fn: () => {
      const r = runHook('rh-agent-result-guard.js', '{"tool_input":');
      assert.strictEqual(r.exitCode, 0, 'should not crash on truncated JSON');
    },
  },
];

module.exports = { tests };

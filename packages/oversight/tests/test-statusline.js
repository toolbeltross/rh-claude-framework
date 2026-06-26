// Unit tests for rh-statusline.js — stdin JSON → 2-line ANSI-formatted status.
//
// All tests go through spawnSync (the script is a self-contained async IIFE).
// Assertions strip ANSI escape codes before string matching.

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'rh-statusline.js');

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function run(stdinStr) {
  return spawnSync('node', [SCRIPT], {
    input: stdinStr,
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
}

// Base payload — normal mid-session state, no git cwd so branch detection is skipped.
function makeInput(overrides = {}) {
  const base = {
    model: { display_name: 'Claude Sonnet 4.6' },
    cost: { total_cost_usd: 1.23, total_duration_ms: 65000, total_turns: 3,
            total_lines_added: 10, total_lines_removed: 2 },
    context_window: {
      used_percentage: 45,
      context_window_size: 200000,
      current_usage: { input_tokens: 80000, cache_read_input_tokens: 10000, cache_creation_input_tokens: 0 },
    },
    workspace: { current_dir: '' },
  };
  return JSON.stringify({ ...base, ...overrides });
}

const tests = [
  {
    name: 'empty stdin → "Claude Code\\n"',
    fn: () => {
      const r = run('');
      assert.strictEqual(r.status, 0);
      assert.strictEqual(r.stdout, 'Claude Code\n');
    },
  },
  {
    name: 'garbage JSON → "Claude Code\\n"',
    fn: () => {
      const r = run('not valid json {{{');
      assert.strictEqual(r.status, 0);
      assert.strictEqual(r.stdout, 'Claude Code\n');
    },
  },
  {
    name: 'session start (ctxPct=0, cost=0) → single-line plain model name',
    fn: () => {
      const r = run(JSON.stringify({
        model: { display_name: 'Claude Opus 4.7' },
        cost: { total_cost_usd: 0, total_duration_ms: 0, total_turns: 0,
                total_lines_added: 0, total_lines_removed: 0 },
        context_window: { used_percentage: 0, context_window_size: 200000,
                          current_usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
        workspace: { current_dir: '' },
      }));
      assert.strictEqual(r.status, 0);
      // Should be plain text, no ANSI, just the model name
      assert.strictEqual(r.stdout, 'Claude Opus 4.7\n');
    },
  },
  {
    name: 'display_name with (foo) parenthetical is stripped',
    fn: () => {
      const r = run(JSON.stringify({
        model: { display_name: 'Claude Sonnet 4.6 (extended)' },
        cost: { total_cost_usd: 0, total_duration_ms: 0, total_turns: 0,
                total_lines_added: 0, total_lines_removed: 0 },
        context_window: { used_percentage: 0, context_window_size: 200000,
                          current_usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
        workspace: { current_dir: '' },
      }));
      assert.strictEqual(r.stdout, 'Claude Sonnet 4.6\n');
    },
  },
  {
    name: 'normal session → exactly 2 output lines',
    fn: () => {
      const r = run(makeInput());
      assert.strictEqual(r.status, 0);
      const lines = r.stdout.split('\n').filter(Boolean);
      assert.strictEqual(lines.length, 2, `expected 2 lines, got: ${JSON.stringify(lines)}`);
    },
  },
  {
    name: 'line 1 contains model name',
    fn: () => {
      const r = run(makeInput());
      const line1 = stripAnsi(r.stdout.split('\n')[0]);
      assert.ok(line1.includes('Claude Sonnet 4.6'), `line1: ${line1}`);
    },
  },
  {
    name: 'line 1 contains formatted cost',
    fn: () => {
      const r = run(makeInput());
      const line1 = stripAnsi(r.stdout.split('\n')[0]);
      assert.ok(line1.includes('$1.23'), `line1: ${line1}`);
    },
  },
  {
    name: 'line 2 contains context percentage',
    fn: () => {
      const r = run(makeInput());
      const line2 = stripAnsi(r.stdout.split('\n')[1]);
      assert.ok(line2.includes('45%'), `line2: ${line2}`);
    },
  },
  {
    name: 'high context (ctxPct ≥ 90) → "!!" warning prefix',
    fn: () => {
      const r = run(makeInput({ context_window: {
        used_percentage: 92,
        context_window_size: 200000,
        current_usage: { input_tokens: 184000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }}));
      // Strip ANSI to find the literal "!!" text
      const plain = stripAnsi(r.stdout);
      assert.ok(plain.includes('!!'), `expected "!!" in output: ${plain}`);
    },
  },
  {
    name: 'medium context (70–89%) → single "!" but no "!!"',
    fn: () => {
      const r = run(makeInput({ context_window: {
        used_percentage: 75,
        context_window_size: 200000,
        current_usage: { input_tokens: 150000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }}));
      const plain = stripAnsi(r.stdout);
      // "! " pattern (without second "!")
      assert.ok(!plain.includes('!!'), `should not have !! at 75%: ${plain}`);
      assert.ok(plain.includes('!'), `should have single ! at 75%: ${plain}`);
    },
  },
  {
    name: 'cache hit pct > 0 → "cache N%" in line 2',
    fn: () => {
      const r = run(makeInput({ context_window: {
        used_percentage: 45,
        context_window_size: 200000,
        current_usage: { input_tokens: 80000, cache_read_input_tokens: 10000, cache_creation_input_tokens: 5000 },
      }}));
      const line2 = stripAnsi(r.stdout.split('\n')[1]);
      assert.ok(line2.includes('cache'), `expected "cache" in line2: ${line2}`);
    },
  },
  {
    name: 'est turns left > 0 → "turns left" in line 2',
    fn: () => {
      // tokens_per_turn = 40000/2 = 20000; remaining = 200000 - 40000 = 160000 → 8 turns
      const r = run(makeInput({
        cost: { total_cost_usd: 0.50, total_duration_ms: 30000, total_turns: 2,
                total_lines_added: 0, total_lines_removed: 0 },
        context_window: {
          used_percentage: 20,
          context_window_size: 200000,
          current_usage: { input_tokens: 40000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      }));
      const line2 = stripAnsi(r.stdout.split('\n')[1]);
      assert.ok(line2.includes('turns left'), `expected "turns left" in line2: ${line2}`);
    },
  },
  {
    name: 'exceeds_200k_tokens: true → "[EXT]" in output',
    fn: () => {
      const r = run(makeInput({ exceeds_200k_tokens: true }));
      const plain = stripAnsi(r.stdout);
      assert.ok(plain.includes('[EXT]'), `expected [EXT]: ${plain}`);
    },
  },
  {
    name: 'worktree name → "[wt:name]" in line 1',
    fn: () => {
      const r = run(makeInput({ worktree: { name: 'my-worktree-abc' } }));
      const line1 = stripAnsi(r.stdout.split('\n')[0]);
      assert.ok(line1.includes('[wt:my-worktree-abc]'), `expected [wt:...] in line1: ${line1}`);
    },
  },
];

module.exports = { tests };

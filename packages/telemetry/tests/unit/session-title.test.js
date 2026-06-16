import assert from 'node:assert';
import { test, summary } from '../helpers/test-harness.js';
import { deriveTitle } from '../../server/session-title.js';

// --- titles produced for direct human prompts ---
test('deriveTitle: strips leading filler and titles a direct prompt', () => {
  const t = deriveTitle('I want to troubleshoot the telemetry dashboard. what cwd is best?');
  assert.ok(t, 'should produce a title');
  assert.match(t, /^Troubleshoot/, `expected leading filler stripped, got: ${t}`);
  assert.ok(t.length <= 41, `title too long: ${t}`);
});

test('deriveTitle: handles a question-style prompt', () => {
  const t = deriveTitle('is this the right cwd to work on the dashboard? should we be up a couple levels?');
  assert.ok(t, 'should produce a title');
  assert.strictEqual(t[0], t[0].toUpperCase(), 'first letter capitalized');
  assert.ok(!/[?]$/.test(t), 'trailing punctuation trimmed');
});

test('deriveTitle: caps length with ellipsis', () => {
  const t = deriveTitle('refactor the entire authentication subsystem across every package and service');
  assert.ok(t.length <= 41, `should be capped, got ${t.length}: ${t}`);
});

// --- rejects (caller falls back to project label) ---
for (const [label, input] of [
  ['slash command', '/rh-quit'],
  ['xml/command tag', '<command-name>foo</command-name>'],
  ['json blob', '{"foo":"bar"}'],
  ['today= scheduled preamble', 'today=2026-06-15\n\nLOCAL CONTEXT (pre-computed)'],
  ['LOCAL CONTEXT lead', 'LOCAL CONTEXT: use verbatim'],
  ['use-the-X-tool automation', 'Use the WebFetch tool on https://example.com and reply'],
  ['path-leading prompt', 'In rh-claude-framework (C:/Users/rossb/OneDrive/Workspace)'],
  ['windows path lead', 'C:\\Users\\rossb\\file.txt please read'],
  ['url lead', 'https://example.com summarize this'],
  ['system-reminder', 'foo <system-reminder>bar</system-reminder>'.replace('foo ', '')],
  ['empty', '   '],
  ['null', null],
]) {
  test(`deriveTitle: rejects ${label} -> null`, () => {
    assert.strictEqual(deriveTitle(input), null, `expected null for ${label}, got: ${JSON.stringify(deriveTitle(input))}`);
  });
}

summary();

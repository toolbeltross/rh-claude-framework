/**
 * Tests for scripts/setup-hooks.js — specifically the hook-config shape
 * produced by buildHookConfig(). Importing the module must NOT run main()
 * (that would write to ~/.claude/settings.json); the CLI guard is what
 * allows this test to exist at all.
 */
import assert from 'assert';
import { test, summary } from '../helpers/test-harness.js';
import { buildHookConfig } from '../../scripts/setup-hooks.js';

console.log('setup-hooks tests:\n');

function getLayer3aPrompt(settings) {
  const stopHooks = settings.hooks?.Stop || [];
  for (const entry of stopHooks) {
    for (const hook of entry.hooks || []) {
      if (hook.type === 'prompt' && hook.prompt?.includes('ADDITIVE ONLY')) {
        return hook.prompt;
      }
    }
  }
  return null;
}

test('buildHookConfig returns settings with Stop hooks including Layer 3a prompt', () => {
  const settings = buildHookConfig({});
  const prompt = getLayer3aPrompt(settings);
  assert.ok(prompt, 'Layer 3a prompt should be present in Stop hooks');
  assert.ok(prompt.includes('Layer 3a narrow supervisory review'));
});

// --- B1'-opt: LLM-self-break loop preamble ---
test('Layer 3a prompt contains LOOP-BREAK CHECK preamble', () => {
  const prompt = getLayer3aPrompt(buildHookConfig({}));
  assert.ok(prompt.includes('LOOP-BREAK CHECK'),
    'prompt should contain LOOP-BREAK CHECK heading');
  assert.ok(prompt.includes('evaluate FIRST, before the 3 rules'),
    'loop-break check should run before the 3 rules');
});

test('Layer 3a prompt instructs LLM to break at 3+ consecutive rejections', () => {
  const prompt = getLayer3aPrompt(buildHookConfig({}));
  assert.ok(prompt.includes('3 or more consecutive assistant turns'),
    'prompt should reference 3+ consecutive turns threshold');
  assert.ok(prompt.includes('loop-break: 3+ consecutive rejections'),
    'prompt should specify the loop-break reason format');
});

test('Layer 3a prompt instructs LLM to break on same-reason repetition', () => {
  const prompt = getLayer3aPrompt(buildHookConfig({}));
  assert.ok(prompt.includes('identical rejection reason repeated') ||
    prompt.includes('same rule cited and substantively the same violation'),
    'prompt should handle same-reason repetition');
  assert.ok(prompt.includes('loop-break: identical rejection reason'),
    'prompt should have the identical-reason loop-break string');
});

test('Layer 3a prompt still includes all 3 original rules', () => {
  const prompt = getLayer3aPrompt(buildHookConfig({}));
  assert.ok(prompt.includes('1. VERIFY BEFORE DECLARING DONE'),
    'Rule 1 must still be present');
  assert.ok(prompt.includes('2. SUBAGENT CROSS-CHECK'),
    'Rule 2 must still be present');
  assert.ok(prompt.includes('3. NO UNVERIFIED EXTRAPOLATION'),
    'Rule 3 must still be present');
});

test('Layer 3a prompt loop-break precedes the 3 rules in the text', () => {
  const prompt = getLayer3aPrompt(buildHookConfig({}));
  const loopBreakIdx = prompt.indexOf('LOOP-BREAK CHECK');
  const rule1Idx = prompt.indexOf('1. VERIFY BEFORE DECLARING DONE');
  assert.ok(loopBreakIdx > 0, 'loop-break preamble must appear');
  assert.ok(rule1Idx > 0, 'rule 1 must appear');
  assert.ok(loopBreakIdx < rule1Idx,
    'loop-break must appear BEFORE rule 1 so LLM evaluates it first');
});

test('buildHookConfig preserves foreign Stop hook entries (idempotent re-run)', () => {
  // Simulate existing settings with a foreign hook alongside ours
  const existing = {
    hooks: {
      Stop: [
        { hooks: [{ type: 'command', command: 'node /some/other/tool.js' }] },
      ],
    },
  };
  const settings = buildHookConfig(existing);
  const stopEntries = settings.hooks.Stop;
  // Our entries should be added
  const layer3aPrompt = getLayer3aPrompt(settings);
  assert.ok(layer3aPrompt, 'Layer 3a prompt should still be present');
  // Foreign entry should still be there
  const foreignStillThere = stopEntries.some((e) =>
    (e.hooks || []).some((h) => h.command?.includes('/some/other/tool.js'))
  );
  assert.ok(foreignStillThere, 'foreign Stop hook should survive re-run');
});

summary();

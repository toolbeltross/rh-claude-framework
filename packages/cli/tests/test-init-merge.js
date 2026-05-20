// Unit tests for lib/init.js mergeHooksData — per-hook additive merge.
//
// Origin: 2026-05-04 incident (F-10) where rh-oversight init's prior merge
// logic dropped hook-forwarder.js stop from the Stop chain after rh-telemetry
// setup had previously added it. Supervisory log silently went 3 days without
// entries. See OVERSIGHT_SYSTEM.md F-10 + framework PROGRESS.md item 11.

const assert = require('assert');
const path = require('path');
const { mergeHooksData, buildConfigData } = require('../lib/init');

// Helper: build a hook entry with given matcher + command list.
// Matcherless entries (Stop, SessionStart, PreCompact, etc.) pass null.
function entry(matcher, commands) {
  const e = { hooks: commands.map(c => ({ type: 'command', command: c })) };
  if (matcher !== null && matcher !== undefined) e.matcher = matcher;
  return e;
}

// Extract command strings from a phase's entries (flattened, in order).
function commandsIn(hooks, phase) {
  const out = [];
  for (const e of hooks[phase] || []) {
    for (const h of e.hooks || []) out.push(h.command || h.prompt || '<other>');
  }
  return out;
}

const tests = [
  // ─── F-10 regression test: the bug this whole effort targets ───────────
  {
    name: 'F-10 regression — telemetry hook-forwarder.js stop in existing Stop chain is preserved when init template is merged in',
    fn: () => {
      // Real-world setup: rh-telemetry setup-hooks.js has set up a Stop chain
      // with hook-forwarder.js stop FIRST, then the oversight scripts.
      const existing = {
        Stop: [entry(null, [
          'node "/p/telemetry/scripts/hook-forwarder.js" stop "$CLAUDE_SESSION_ID"',
          'node /home/u/.claude/scripts/rh-scribe-prefilter.js',
          'node /home/u/.claude/scripts/rh-layer3a-capture.js',
        ])],
      };
      // The oversight template only knows about its own hooks (no telemetry).
      const template = {
        Stop: [entry(null, [
          'node /home/u/.claude/scripts/rh-scribe-prefilter.js',
          'node /home/u/.claude/scripts/rh-layer3a-capture.js',
        ])],
      };
      const merged = mergeHooksData(existing, template);
      const cmds = commandsIn(merged, 'Stop');
      // Critical assertion: the telemetry hook is still there.
      assert.ok(
        cmds.some(c => c.includes('hook-forwarder.js') && c.includes('stop')),
        `hook-forwarder.js stop must be preserved; got: ${JSON.stringify(cmds)}`
      );
      // No duplicates of the oversight hooks.
      const prefilterCount = cmds.filter(c => c.includes('rh-scribe-prefilter.js')).length;
      const captureCount = cmds.filter(c => c.includes('rh-layer3a-capture.js')).length;
      assert.strictEqual(prefilterCount, 1, `rh-scribe-prefilter.js should appear once; got ${prefilterCount}`);
      assert.strictEqual(captureCount, 1, `rh-layer3a-capture.js should appear once; got ${captureCount}`);
      // One Stop entry total (per-hook merge keeps the chain consolidated).
      assert.strictEqual(merged.Stop.length, 1, `Stop should have exactly one entry; got ${merged.Stop.length}`);
    },
  },

  // ─── Cold-start: empty existing settings ───────────────────────────────
  {
    name: 'cold-start — empty existing hooks, template entries added verbatim',
    fn: () => {
      const merged = mergeHooksData({}, {
        Stop: [entry(null, ['node /a.js', 'node /b.js'])],
      });
      assert.strictEqual(merged.Stop.length, 1);
      assert.deepStrictEqual(commandsIn(merged, 'Stop'), ['node /a.js', 'node /b.js']);
    },
  },

  // ─── Idempotent re-run: same template applied twice, no duplicates ─────
  {
    name: 'idempotent re-run — template applied twice produces same result as once',
    fn: () => {
      const template = { Stop: [entry(null, ['node /x.js', 'node /y.js'])] };
      const once = mergeHooksData({}, template);
      const twice = mergeHooksData(once, template);
      assert.deepStrictEqual(commandsIn(once, 'Stop'), commandsIn(twice, 'Stop'));
      assert.strictEqual(twice.Stop.length, 1);
    },
  },

  // ─── Foreign matcher preserved (e.g., user-customized PreToolUse) ──────
  {
    name: 'foreign matcher preserved — different-matcher entries do not collide',
    fn: () => {
      const existing = {
        PreToolUse: [entry('CustomTool', ['node /custom.js'])],
      };
      const template = {
        PreToolUse: [entry('Bash', ['node /tool-validator.js'])],
      };
      const merged = mergeHooksData(existing, template);
      assert.strictEqual(merged.PreToolUse.length, 2, 'should have both entries (different matchers)');
      const customEntry = merged.PreToolUse.find(e => e.matcher === 'CustomTool');
      const bashEntry = merged.PreToolUse.find(e => e.matcher === 'Bash');
      assert.ok(customEntry, 'CustomTool entry preserved');
      assert.ok(bashEntry, 'Bash entry added');
    },
  },

  // ─── Multi-phase: each phase merged independently ──────────────────────
  {
    name: 'multi-phase — Stop and PostToolUse merged independently',
    fn: () => {
      const existing = {
        Stop: [entry(null, ['node /existing-stop.js'])],
        PostToolUse: [entry('Read', ['node /existing-read.js'])],
      };
      const template = {
        Stop: [entry(null, ['node /template-stop.js'])],
        SessionStart: [entry(null, ['node /template-start.js'])],
      };
      const merged = mergeHooksData(existing, template);
      assert.deepStrictEqual(
        commandsIn(merged, 'Stop'),
        ['node /existing-stop.js', 'node /template-stop.js'],
        'Stop merged additively'
      );
      assert.deepStrictEqual(
        commandsIn(merged, 'PostToolUse'),
        ['node /existing-read.js'],
        'PostToolUse untouched (template did not specify)'
      );
      assert.deepStrictEqual(
        commandsIn(merged, 'SessionStart'),
        ['node /template-start.js'],
        'SessionStart added (existing had none)'
      );
    },
  },

  // ─── Prompt-type hooks dedupe by prompt body ───────────────────────────
  {
    name: 'prompt-type hooks deduped by prompt body',
    fn: () => {
      const existing = {
        Stop: [{ hooks: [
          { type: 'prompt', prompt: 'review the turn' },
          { type: 'command', command: 'node /a.js' },
        ] }],
      };
      const template = {
        Stop: [{ hooks: [
          { type: 'prompt', prompt: 'review the turn' }, // same prompt → dedupe
          { type: 'command', command: 'node /b.js' },    // new command → add
        ] }],
      };
      const merged = mergeHooksData(existing, template);
      const stopHooks = merged.Stop[0].hooks;
      assert.strictEqual(stopHooks.length, 3, `should have 3 hooks (1 prompt + 2 commands); got ${stopHooks.length}`);
      const promptCount = stopHooks.filter(h => h.type === 'prompt').length;
      assert.strictEqual(promptCount, 1, `prompt should not be duplicated; got ${promptCount}`);
    },
  },

  // ─── Layer 3a prompt-signature dedupe ──────────────────────────────────
  // Surfaced 2026-05-08 by P2-2 cross-package contract test. Telemetry and
  // oversight both ship a Stop-phase Layer 3a supervisory prompt. The two
  // prompt bodies drift over time (rule edits) but represent the same role.
  // Plain prompt-body hashing would keep both, doubling per-turn cost.
  {
    name: 'two Layer 3a prompts with different bodies dedupe to one (signature-based key)',
    fn: () => {
      const existing = {
        Stop: [{ hooks: [
          { type: 'prompt', prompt: 'ADDITIVE ONLY — Layer 3a narrow supervisory review.\n\nBody A: shorter wording.' },
          { type: 'command', command: 'node /a.js' },
        ] }],
      };
      const template = {
        Stop: [{ hooks: [
          { type: 'prompt', prompt: 'ADDITIVE ONLY — Layer 3a narrow supervisory review.\n\nBody B: different (longer) wording.\nMore details about rules.' },
          { type: 'command', command: 'node /b.js' },
        ] }],
      };
      const merged = mergeHooksData(existing, template);
      const stopHooks = merged.Stop[0].hooks;
      const layer3aPromptCount = stopHooks.filter(h =>
        h.type === 'prompt' && h.prompt?.includes('ADDITIVE ONLY') && h.prompt?.includes('Layer 3a')
      ).length;
      assert.strictEqual(layer3aPromptCount, 1,
        `should dedupe Layer 3a prompts to one regardless of body wording; got ${layer3aPromptCount}`);
      // The first one (existing) wins — template's prompt is dropped.
      const layer3aPrompt = stopHooks.find(h => h.type === 'prompt' && h.prompt?.includes('Layer 3a'));
      assert.ok(layer3aPrompt.prompt.includes('Body A'),
        'existing Layer 3a prompt should be preserved over template (first-write wins)');
      // Both commands still present.
      assert.ok(stopHooks.some(h => h.command === 'node /a.js'), 'existing command preserved');
      assert.ok(stopHooks.some(h => h.command === 'node /b.js'), 'template command added');
    },
  },
  {
    name: 'non-Layer-3a prompts still dedupe by full body (existing behavior preserved)',
    fn: () => {
      const existing = {
        Stop: [{ hooks: [{ type: 'prompt', prompt: 'Custom review prompt' }] }],
      };
      const template = {
        Stop: [{ hooks: [{ type: 'prompt', prompt: 'Custom review prompt' }] }], // identical
      };
      const merged = mergeHooksData(existing, template);
      const promptCount = merged.Stop[0].hooks.filter(h => h.type === 'prompt').length;
      assert.strictEqual(promptCount, 1, 'identical custom prompts still dedupe');
    },
  },
  {
    name: 'two distinct non-Layer-3a prompts both kept (signature dedup is targeted, not blanket)',
    fn: () => {
      const existing = {
        Stop: [{ hooks: [{ type: 'prompt', prompt: 'Prompt one' }] }],
      };
      const template = {
        Stop: [{ hooks: [{ type: 'prompt', prompt: 'Prompt two' }] }],
      };
      const merged = mergeHooksData(existing, template);
      const promptCount = merged.Stop[0].hooks.filter(h => h.type === 'prompt').length;
      assert.strictEqual(promptCount, 2, 'distinct non-signature prompts both kept');
    },
  },

  // ─── Input mutation guard: does not mutate caller objects ──────────────
  {
    name: 'mergeHooksData does not mutate input objects',
    fn: () => {
      const existing = { Stop: [entry(null, ['node /a.js'])] };
      const template = { Stop: [entry(null, ['node /b.js'])] };
      const existingSnapshot = JSON.parse(JSON.stringify(existing));
      const templateSnapshot = JSON.parse(JSON.stringify(template));
      mergeHooksData(existing, template);
      assert.deepStrictEqual(existing, existingSnapshot, 'existing must not be mutated');
      assert.deepStrictEqual(template, templateSnapshot, 'template must not be mutated');
    },
  },

  // ─── buildConfigData: written oversight.json carries oversightLogPath ───
  // Added 2026-05-19. Prior behavior dropped `oversightLogPath` on every init
  // re-run; the runtime then fell back to the hardcoded
  // ~/.claude/oversight/supervisory-log.md default even when oversightDir had
  // been redirected. Test pins the new contract: configData written by init
  // includes oversightLogPath derived from oversightDir.
  {
    name: 'buildConfigData includes oversightLogPath derived from oversightDir',
    fn: () => {
      const data = buildConfigData({
        workspace: '/tmp/workspace',
        oversightDir: '/tmp/custom-oversight',
      });
      assert.strictEqual(data.oversightDir, '/tmp/custom-oversight');
      assert.strictEqual(
        data.oversightLogPath.replace(/\\/g, '/'),
        '/tmp/custom-oversight/supervisory-log.md',
        'log path co-locates with oversightDir'
      );
      assert.strictEqual(data.workspace, '/tmp/workspace');
      assert.strictEqual(data.telemetryPort, 7890);
      assert.ok(data.userName, 'userName is present');
    },
  },
  {
    name: 'buildConfigData includes privateDirs only when provided',
    fn: () => {
      const without = buildConfigData({ workspace: '/w', oversightDir: '/o' });
      assert.ok(!('privateDirs' in without), 'privateDirs omitted when not provided');
      const withPrivate = buildConfigData({
        workspace: '/w',
        oversightDir: '/o',
        privateDirs: ['Personal', 'Financial'],
      });
      assert.deepStrictEqual(withPrivate.privateDirs, ['Personal', 'Financial']);
    },
  },
];

module.exports = { tests };

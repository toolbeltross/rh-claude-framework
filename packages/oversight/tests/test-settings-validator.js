// Unit tests for lib/settings-validator.js.
//
// P2-4 (2026-05-10): schema validation pre-write minimum for settings.json,
// closing the F-10 class of failures where a malformed merge silently
// corrupts hook chains.

const assert = require('assert');
const { validateSettings, formatIssues } = require('../scripts/lib/settings-validator');

function codesOf(issues) { return issues.map(i => i.code).sort(); }

const tests = [
  // ── Happy path ────────────────────────────────────────────────────────
  {
    name: 'empty object is valid (no hooks, no env, no nothing)',
    fn: () => {
      const r = validateSettings({});
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.errors.length, 0);
    }
  },
  {
    name: 'minimal valid settings — env + hooks + permissions all present',
    fn: () => {
      const r = validateSettings({
        env: { MY_VAR: 'hello' },
        permissions: { allow: ['Bash(ls)'], deny: [] },
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'node ~/.claude/scripts/x.js' }] }],
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo' }] }],
        },
      });
      assert.strictEqual(r.ok, true, formatIssues(r));
    }
  },

  // ── Root-level errors ─────────────────────────────────────────────────
  {
    name: 'non-object root fails',
    fn: () => {
      assert.strictEqual(validateSettings(null).ok, false);
      assert.strictEqual(validateSettings('hello').ok, false);
      assert.strictEqual(validateSettings([]).ok, false);
      assert.strictEqual(validateSettings(42).ok, false);
    }
  },
  {
    name: 'unknown top-level keys produce warnings, not errors',
    fn: () => {
      const r = validateSettings({ futureFeature: { foo: 1 } });
      assert.strictEqual(r.ok, true);
      assert.deepStrictEqual(codesOf(r.warnings), ['root.unknown-key']);
    }
  },

  // ── env ───────────────────────────────────────────────────────────────
  {
    name: 'env must be an object',
    fn: () => {
      const r = validateSettings({ env: ['array', 'not', 'object'] });
      assert.strictEqual(r.ok, false);
      assert.ok(codesOf(r.errors).includes('env.not-object'));
    }
  },
  {
    name: 'env values must be strings',
    fn: () => {
      const r = validateSettings({ env: { GOOD: 'yes', BAD: 42 } });
      assert.strictEqual(r.ok, false);
      assert.ok(codesOf(r.errors).includes('env.value.not-string'));
    }
  },

  // ── permissions ───────────────────────────────────────────────────────
  {
    name: 'permissions.allow/deny must be arrays',
    fn: () => {
      const r = validateSettings({ permissions: { allow: 'Bash(ls)' } });
      assert.strictEqual(r.ok, false);
      assert.ok(codesOf(r.errors).includes('permissions.allow.not-array'));
    }
  },

  // ── hooks shape ───────────────────────────────────────────────────────
  {
    name: 'hooks must be an object',
    fn: () => {
      const r = validateSettings({ hooks: [] });
      assert.strictEqual(r.ok, false);
      assert.ok(codesOf(r.errors).includes('hooks.not-object'));
    }
  },
  {
    name: 'unknown phase produces warning, not error',
    fn: () => {
      const r = validateSettings({
        hooks: { FutureHook: [{ hooks: [{ type: 'command', command: 'x' }] }] }
      });
      assert.strictEqual(r.ok, true);
      assert.ok(codesOf(r.warnings).includes('hooks.phase.unknown'));
    }
  },
  {
    // Regression for the 5 phases added 2026-06-13 (PR #66). These are real
    // Claude Code hook phases present in live settings.json; before the fix they
    // each produced a spurious hooks.phase.unknown warning on every validate run.
    name: 'recognized phases (incl. PostToolUseFailure/ConfigChange/TaskCompleted/InstructionsLoaded/PermissionRequest) produce no unknown-phase warning',
    fn: () => {
      const entry = [{ hooks: [{ type: 'command', command: 'x' }] }];
      const phases = [
        'PostToolUseFailure', 'ConfigChange', 'TaskCompleted',
        'InstructionsLoaded', 'PermissionRequest',
      ];
      const hooks = {};
      for (const p of phases) hooks[p] = entry;
      const r = validateSettings({ hooks });
      assert.strictEqual(r.ok, true, formatIssues(r));
      assert.ok(
        !codesOf(r.warnings).includes('hooks.phase.unknown'),
        `expected no unknown-phase warning, got: ${formatIssues(r)}`
      );
    }
  },
  {
    name: 'phase value must be an array',
    fn: () => {
      const r = validateSettings({ hooks: { Stop: { not: 'array' } } });
      assert.strictEqual(r.ok, false);
      assert.ok(codesOf(r.errors).includes('hooks.phase.not-array'));
    }
  },
  {
    name: 'empty phase array → warning',
    fn: () => {
      const r = validateSettings({ hooks: { Stop: [] } });
      assert.strictEqual(r.ok, true);
      assert.ok(codesOf(r.warnings).includes('hooks.phase.empty'));
    }
  },

  // ── hook entries ──────────────────────────────────────────────────────
  {
    name: 'entry must be an object',
    fn: () => {
      const r = validateSettings({ hooks: { Stop: ['just a string'] } });
      assert.strictEqual(r.ok, false);
      assert.ok(codesOf(r.errors).includes('hooks.entry.not-object'));
    }
  },
  {
    name: 'entry without hooks array → error',
    fn: () => {
      const r = validateSettings({ hooks: { Stop: [{ matcher: '*' }] } });
      assert.strictEqual(r.ok, false);
      assert.ok(codesOf(r.errors).includes('hooks.entry.missing-hooks'));
    }
  },
  {
    name: 'entry with empty hooks array → warning, not error',
    fn: () => {
      const r = validateSettings({ hooks: { Stop: [{ hooks: [] }] } });
      assert.strictEqual(r.ok, true);
      assert.ok(codesOf(r.warnings).includes('hooks.entry.empty-hooks'));
    }
  },
  {
    name: 'matcher type validated — non-string fails',
    fn: () => {
      const r = validateSettings({
        hooks: { PreToolUse: [{ matcher: 42, hooks: [{ type: 'command', command: 'x' }] }] }
      });
      assert.strictEqual(r.ok, false);
      assert.ok(codesOf(r.errors).includes('hooks.entry.matcher.not-string'));
    }
  },

  // ── hook items ────────────────────────────────────────────────────────
  {
    name: 'hook item must be an object',
    fn: () => {
      const r = validateSettings({
        hooks: { Stop: [{ hooks: ['string-not-object'] }] }
      });
      assert.strictEqual(r.ok, false);
      assert.ok(codesOf(r.errors).includes('hooks.item.not-object'));
    }
  },
  {
    name: 'hook item with bad type → error',
    fn: () => {
      const r = validateSettings({
        hooks: { Stop: [{ hooks: [{ type: 'magical', command: 'x' }] }] }
      });
      assert.strictEqual(r.ok, false);
      assert.ok(codesOf(r.errors).includes('hooks.item.bad-type'));
    }
  },
  {
    name: 'command-type hook missing command field → error',
    fn: () => {
      const r = validateSettings({
        hooks: { Stop: [{ hooks: [{ type: 'command' }] }] }
      });
      assert.strictEqual(r.ok, false);
      assert.ok(codesOf(r.errors).includes('hooks.item.command.missing'));
    }
  },
  {
    name: 'command-type hook with empty/whitespace command → error',
    fn: () => {
      const r = validateSettings({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: '   ' }] }] }
      });
      assert.strictEqual(r.ok, false);
      assert.ok(codesOf(r.errors).includes('hooks.item.command.missing'));
    }
  },
  {
    name: 'prompt-type hook missing prompt field → error',
    fn: () => {
      const r = validateSettings({
        hooks: { Stop: [{ hooks: [{ type: 'prompt' }] }] }
      });
      assert.strictEqual(r.ok, false);
      assert.ok(codesOf(r.errors).includes('hooks.item.prompt.missing'));
    }
  },
  {
    name: 'prompt-type hook with valid prompt → ok',
    fn: () => {
      const r = validateSettings({
        hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt: 'review the turn please' }] }] }
      });
      assert.strictEqual(r.ok, true);
    }
  },

  // ── Duplicate detection (F-10 inverse) ────────────────────────────────
  {
    name: 'two entries with identical matcher + commands → duplicate warning',
    fn: () => {
      const r = validateSettings({
        hooks: {
          Stop: [
            { hooks: [{ type: 'command', command: 'node /x.js' }] },
            { hooks: [{ type: 'command', command: 'node /x.js' }] },
          ]
        }
      });
      assert.strictEqual(r.ok, true);
      assert.ok(codesOf(r.warnings).includes('hooks.entry.duplicate'));
    }
  },
  {
    name: 'entries with same matcher but different commands → no duplicate warning',
    fn: () => {
      const r = validateSettings({
        hooks: {
          PreToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'node /a.js' }] },
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'node /b.js' }] },
          ]
        }
      });
      assert.strictEqual(r.ok, true);
      const dupes = r.warnings.filter(w => w.code === 'hooks.entry.duplicate');
      assert.strictEqual(dupes.length, 0);
    }
  },

  // ── F-10 regression check via validator ───────────────────────────────
  {
    name: 'F-10 shape: foreign telemetry hook in Stop chain alongside oversight → valid',
    fn: () => {
      const r = validateSettings({
        hooks: {
          Stop: [{
            hooks: [
              { type: 'command', command: 'node ~/.claude/scripts/rh-scribe-prefilter.js' },
              { type: 'prompt', prompt: '[ADDITIVE ONLY — Layer 3a narrow supervisory review...]' },
              { type: 'command', command: 'node ~/.claude/scripts/hook-forwarder.js stop' },
            ],
          }],
        },
      });
      assert.strictEqual(r.ok, true, formatIssues(r));
    }
  },

  // ── Format helper ─────────────────────────────────────────────────────
  {
    name: 'formatIssues — OK message when no errors/warnings',
    fn: () => {
      assert.strictEqual(formatIssues({}), 'OK — no issues');
    }
  },
  {
    name: 'formatIssues — distinguishes errors from warnings',
    fn: () => {
      const out = formatIssues({
        errors: [{ code: 'e1', path: '$.a', message: 'bad' }],
        warnings: [{ code: 'w1', path: '$.b', message: 'meh' }],
      });
      assert.ok(out.includes('ERRORS (1)'));
      assert.ok(out.includes('WARNINGS (1)'));
      assert.ok(out.includes('[e1]'));
      assert.ok(out.includes('[w1]'));
    }
  },
];

module.exports = { tests };

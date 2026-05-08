// Cross-package contract test (P2-2). Closes the F-10 regression class.
//
// Origin: 2026-05-04 incident where rh-oversight init blew away rh-telemetry's
// hook-forwarder.js stop entry from the Stop chain. The supervisory log went
// 3 days without entries before manual investigation surfaced it. PR #18
// fixed the merge logic at the unit level (test-init-merge.js); this test
// verifies the cross-package outcome — that running rh-telemetry setup AND
// rh-oversight init in either order produces a Stop chain containing all
// expected hooks from both packages.
//
// Mechanism: spawns the ESM helper run-cross-package-merge.mjs to invoke
// the real buildHookConfig (telemetry, ESM-only) and real mergeHooksData
// (oversight, CJS) with empty initial settings. The helper outputs the
// merged settings.hooks JSON. This test parses + asserts.
//
// Why a subprocess: telemetry's setup-hooks.js is ESM, oversight's tests
// are CJS, and node's CJS test harness runs t.fn() synchronously without
// support for top-level await on dynamic imports. Subprocess sidesteps the
// entire interop issue and exercises the actual modules unchanged.

const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');

const HELPER = path.join(__dirname, 'helpers', 'run-cross-package-merge.mjs');

function runScenario(scenario) {
  const stdout = execFileSync('node', [HELPER, scenario], {
    encoding: 'utf8',
    // Capture stderr separately so spawn errors surface clearly:
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return JSON.parse(stdout);
}

// Flatten all command + prompt hooks across every entry in a phase so we
// can assert "is X present" without caring whether the merge produced one
// entry or two (the two orderings legitimately produce different shapes).
function flattenPhase(hooksByPhase, phase) {
  const out = [];
  for (const entry of hooksByPhase[phase] || []) {
    for (const h of entry.hooks || []) {
      out.push({
        matcher: entry.matcher || '*',
        type: h.type,
        command: h.command || null,
        prompt: h.prompt || null,
      });
    }
  }
  return out;
}

function countMatching(hooksByPhase, phase, predicate) {
  return flattenPhase(hooksByPhase, phase).filter(predicate).length;
}

function assertContains(hooksByPhase, phase, predicate, label, scenario) {
  const n = countMatching(hooksByPhase, phase, predicate);
  assert.ok(
    n >= 1,
    `[${scenario}] ${phase} should contain ${label}; got ${n} matches`
  );
}

function assertExactlyOnce(hooksByPhase, phase, predicate, label, scenario) {
  const n = countMatching(hooksByPhase, phase, predicate);
  assert.strictEqual(
    n, 1,
    `[${scenario}] ${phase} should contain ${label} exactly once; got ${n}`
  );
}

const tests = [
  // ─── F-10 cross-package contract: oversight-first ───────────────────────
  {
    name: 'oversight-first: telemetry hook-forwarder stop is preserved when oversight installed first then telemetry runs',
    fn: () => {
      const { hooks } = runScenario('oversight-first');
      assertContains(hooks, 'Stop',
        h => h.command?.includes('hook-forwarder.js') && h.command?.includes('stop'),
        'telemetry hook-forwarder.js stop',
        'oversight-first');
    },
  },
  {
    name: 'oversight-first: oversight rh-scribe-prefilter survives telemetry running on top',
    fn: () => {
      const { hooks } = runScenario('oversight-first');
      assertContains(hooks, 'Stop',
        h => h.command?.includes('rh-scribe-prefilter.js'),
        'oversight rh-scribe-prefilter.js',
        'oversight-first');
    },
  },
  {
    name: 'oversight-first: oversight rh-layer3a-capture survives telemetry running on top',
    fn: () => {
      const { hooks } = runScenario('oversight-first');
      assertContains(hooks, 'Stop',
        h => h.command?.includes('rh-layer3a-capture.js'),
        'oversight rh-layer3a-capture.js',
        'oversight-first');
    },
  },
  {
    name: 'oversight-first: at least one Layer 3a prompt is present',
    fn: () => {
      const { hooks } = runScenario('oversight-first');
      assertContains(hooks, 'Stop',
        h => h.type === 'prompt' && h.prompt?.includes('ADDITIVE ONLY') && h.prompt?.includes('Layer 3a'),
        'a Layer 3a supervisory prompt',
        'oversight-first');
    },
  },

  // ─── F-10 cross-package contract: telemetry-first ───────────────────────
  {
    name: 'telemetry-first: telemetry hook-forwarder stop is preserved when telemetry installed first then oversight runs',
    fn: () => {
      const { hooks } = runScenario('telemetry-first');
      assertContains(hooks, 'Stop',
        h => h.command?.includes('hook-forwarder.js') && h.command?.includes('stop'),
        'telemetry hook-forwarder.js stop',
        'telemetry-first');
    },
  },
  {
    name: 'telemetry-first: oversight rh-scribe-prefilter is added on top',
    fn: () => {
      const { hooks } = runScenario('telemetry-first');
      assertContains(hooks, 'Stop',
        h => h.command?.includes('rh-scribe-prefilter.js'),
        'oversight rh-scribe-prefilter.js',
        'telemetry-first');
    },
  },
  {
    name: 'telemetry-first: oversight rh-layer3a-capture is added on top',
    fn: () => {
      const { hooks } = runScenario('telemetry-first');
      assertContains(hooks, 'Stop',
        h => h.command?.includes('rh-layer3a-capture.js'),
        'oversight rh-layer3a-capture.js',
        'telemetry-first');
    },
  },

  // ─── No-duplication invariants (the inverse F-10 failure mode) ──────────
  {
    name: 'oversight-first: hook-forwarder.js stop appears exactly once (no duplication)',
    fn: () => {
      const { hooks } = runScenario('oversight-first');
      assertExactlyOnce(hooks, 'Stop',
        h => h.command?.includes('hook-forwarder.js') && h.command?.includes('stop'),
        'hook-forwarder.js stop',
        'oversight-first');
    },
  },
  {
    name: 'telemetry-first: hook-forwarder.js stop appears exactly once (no duplication)',
    fn: () => {
      const { hooks } = runScenario('telemetry-first');
      assertExactlyOnce(hooks, 'Stop',
        h => h.command?.includes('hook-forwarder.js') && h.command?.includes('stop'),
        'hook-forwarder.js stop',
        'telemetry-first');
    },
  },
  {
    name: 'oversight-first: rh-scribe-prefilter appears exactly once (no duplication)',
    fn: () => {
      const { hooks } = runScenario('oversight-first');
      assertExactlyOnce(hooks, 'Stop',
        h => h.command?.includes('rh-scribe-prefilter.js'),
        'rh-scribe-prefilter.js',
        'oversight-first');
    },
  },
  {
    name: 'telemetry-first: rh-scribe-prefilter appears exactly once (no duplication)',
    fn: () => {
      const { hooks } = runScenario('telemetry-first');
      assertExactlyOnce(hooks, 'Stop',
        h => h.command?.includes('rh-scribe-prefilter.js'),
        'rh-scribe-prefilter.js',
        'telemetry-first');
    },
  },

  // ─── SessionStart contract: both packages add their own ─────────────────
  {
    name: 'oversight-first: SessionStart contains both telemetry start-bg and oversight rh-agents-loaded-marker',
    fn: () => {
      const { hooks } = runScenario('oversight-first');
      assertContains(hooks, 'SessionStart',
        h => h.command?.includes('start-bg.js'), 'telemetry start-bg.js', 'oversight-first');
      assertContains(hooks, 'SessionStart',
        h => h.command?.includes('rh-agents-loaded-marker.js'), 'oversight rh-agents-loaded-marker.js', 'oversight-first');
      assertContains(hooks, 'SessionStart',
        h => h.command?.includes('rh-daily-regen-trigger.js'), 'oversight rh-daily-regen-trigger.js', 'oversight-first');
    },
  },
  {
    name: 'telemetry-first: SessionStart contains both telemetry start-bg and oversight rh-agents-loaded-marker',
    fn: () => {
      const { hooks } = runScenario('telemetry-first');
      assertContains(hooks, 'SessionStart',
        h => h.command?.includes('start-bg.js'), 'telemetry start-bg.js', 'telemetry-first');
      assertContains(hooks, 'SessionStart',
        h => h.command?.includes('rh-agents-loaded-marker.js'), 'oversight rh-agents-loaded-marker.js', 'telemetry-first');
      assertContains(hooks, 'SessionStart',
        h => h.command?.includes('rh-daily-regen-trigger.js'), 'oversight rh-daily-regen-trigger.js', 'telemetry-first');
    },
  },

  // ─── PostToolUse contract: telemetry's matcherless tool forwarder + oversight's matched guards ───
  {
    name: 'oversight-first: PostToolUse retains telemetry hook-forwarder tool AND oversight Agent + Read guards',
    fn: () => {
      const { hooks } = runScenario('oversight-first');
      assertContains(hooks, 'PostToolUse',
        h => h.command?.includes('hook-forwarder.js') && h.command?.includes('tool'),
        'telemetry hook-forwarder.js tool', 'oversight-first');
      assertContains(hooks, 'PostToolUse',
        h => h.command?.includes('rh-agent-result-guard.js') && h.matcher === 'Agent',
        'oversight rh-agent-result-guard.js (matcher=Agent)', 'oversight-first');
      assertContains(hooks, 'PostToolUse',
        h => h.command?.includes('rh-read-audit.js') && h.matcher === 'Read',
        'oversight rh-read-audit.js (matcher=Read)', 'oversight-first');
    },
  },
  {
    name: 'telemetry-first: PostToolUse retains telemetry hook-forwarder tool AND oversight Agent + Read guards',
    fn: () => {
      const { hooks } = runScenario('telemetry-first');
      assertContains(hooks, 'PostToolUse',
        h => h.command?.includes('hook-forwarder.js') && h.command?.includes('tool'),
        'telemetry hook-forwarder.js tool', 'telemetry-first');
      assertContains(hooks, 'PostToolUse',
        h => h.command?.includes('rh-agent-result-guard.js') && h.matcher === 'Agent',
        'oversight rh-agent-result-guard.js (matcher=Agent)', 'telemetry-first');
      assertContains(hooks, 'PostToolUse',
        h => h.command?.includes('rh-read-audit.js') && h.matcher === 'Read',
        'oversight rh-read-audit.js (matcher=Read)', 'telemetry-first');
    },
  },
];

module.exports = { tests };

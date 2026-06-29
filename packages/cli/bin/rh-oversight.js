#!/usr/bin/env node
// rh-oversight CLI — init, reset, self-test, generate-state
//
// Lives in packages/cli/ (Phase 4 of 5-package reorg). Sibling-package
// scripts (oversight, output) are resolved via PACKAGES_ROOT.

const path = require('path');
const command = process.argv[2];

// Preflight: this framework (and the bundled telemetry dashboard) requires
// Node >= 18. Fail fast with a clear message rather than a cryptic error deep
// in an install on an old runtime.
const MAJOR = parseInt(process.versions.node.split('.')[0], 10);
if (Number.isFinite(MAJOR) && MAJOR < 18) {
  console.error(`rh-oversight requires Node.js >= 18 (you have ${process.versions.node}).`);
  console.error('Upgrade Node, then re-run. See https://nodejs.org/.');
  process.exit(1);
}

const PACKAGES_ROOT = path.join(__dirname, '..', '..');
const OVERSIGHT_SCRIPTS = path.join(PACKAGES_ROOT, 'oversight', 'scripts');
const OUTPUT_SCRIPTS = path.join(PACKAGES_ROOT, 'output', 'scripts');

const commands = {
  init:           () => require('../lib/init').run(),
  reset:          () => require('../lib/init').run({ reset: true }),
  'self-test':    () => require('child_process').spawnSync('node', [path.join(OVERSIGHT_SCRIPTS, 'rh-oversight-self-test.js')], { stdio: 'inherit' }),
  'generate-state': () => require('child_process').spawnSync('node', [path.join(OUTPUT_SCRIPTS, 'rh-generate-state-md.js')], { stdio: 'inherit' }),
  'generate-env':   () => require('child_process').spawnSync('node', [path.join(OUTPUT_SCRIPTS, 'rh-generate-env-md.js')], { stdio: 'inherit' }),
  health:         () => {
    const args = process.argv.slice(3);
    const r = require('child_process').spawnSync('node', [path.join(OVERSIGHT_SCRIPTS, 'rh-oversight-health.js'), ...args], { stdio: 'inherit' });
    process.exit(r.status ?? 0);
  },
  settings:       () => {
    const args = process.argv.slice(3);
    const code = require('../lib/settings-cli').run(args);
    process.exit(code);
  },
  'supervisor-sweep': () => {
    const args = process.argv.slice(3);
    const code = require(path.join(OVERSIGHT_SCRIPTS, 'rh-supervisor-sweep')).run(args);
    process.exit(code);
  },
};

if (!command || command === '--help' || command === '-h') {
  console.log(`
rh-oversight — Claude Code oversight framework CLI

Usage: rh-oversight <command> [options]

Commands:
  init              Install oversight framework to ~/.claude/
  reset             Remove and reinstall (preserves oversight.json config)
  self-test         Run oversight self-test suite
  generate-state    Regenerate OVERSIGHT_STATE.md
  generate-env      Regenerate ENVIRONMENT.md
  health [--json]   One-screen health aggregator (regen + journals + telemetry +
                    alerts + scribe backlog + subagent orphans). Exit 0/1/2.
  settings <sub>    Merge-aware CLI for settings.json. Subcommands:
                    validate / show / diff / merge / backup / restore.
                    Run 'rh-oversight settings --help' for details.
  supervisor-sweep  Cross-session/project trend doc (default 7-day window).
                    Reads oversight-events.jsonl + supervisory-log.md;
                    writes ~/.claude/memory-shared/supervisor-trends.md.
                    Flags: --days N --out <path> --json --dry-run.

Options for init/reset:
  --workspace <path>      Workspace root directory (auto-detected if omitted)
  --oversight-dir <path>  Dir where the locally-specific oversight files are read/written
                          (design doc OVERSIGHT_SYSTEM.md, generated OVERSIGHT_STATE.md,
                          supervisory log). If omitted on an interactive (TTY) run, init
                          prompts for it; otherwise autodetected, default ~/.claude/oversight.
  --private-dirs <dirs>   Comma-separated private directory names (e.g., "Personal,Financial")
  --dry-run               Show what would be done without writing files
  --skip-hooks            Don't merge hooks into settings.json
  --yes, -y               Accept defaults; never prompt (alias: --no-prompt)
`);
  process.exit(0);
}

if (!commands[command]) {
  console.error(`Unknown command: ${command}\nRun 'rh-oversight --help' for usage.`);
  process.exit(1);
}

// Run the command, catching both synchronous throws and async rejections so a
// mid-install failure surfaces a clear recovery path instead of a raw stack.
Promise.resolve()
  .then(() => commands[command]())
  .catch((err) => {
    console.error(`\nrh-oversight ${command} failed: ${err && err.message ? err.message : err}`);
    if (command === 'init' || command === 'reset') {
      console.error('If the install left partial state, recover with:  rh-oversight reset && rh-oversight init');
    }
    process.exit(1);
  });

#!/usr/bin/env node
// rh-oversight CLI — init, reset, self-test, generate-state

const path = require('path');
const command = process.argv[2];

const commands = {
  init:           () => require('../lib/init').run(),
  reset:          () => require('../lib/init').run({ reset: true }),
  'self-test':    () => require('child_process').spawnSync('node', [path.join(__dirname, '..', 'scripts', 'rh-oversight-self-test.js')], { stdio: 'inherit' }),
  'generate-state': () => require('child_process').spawnSync('node', [path.join(__dirname, '..', 'scripts', 'rh-generate-state-md.js')], { stdio: 'inherit' }),
  'generate-env':   () => require('child_process').spawnSync('node', [path.join(__dirname, '..', 'scripts', 'rh-generate-env-md.js')], { stdio: 'inherit' }),
  health:         () => {
    const args = process.argv.slice(3);
    const r = require('child_process').spawnSync('node', [path.join(__dirname, '..', 'scripts', 'rh-oversight-health.js'), ...args], { stdio: 'inherit' });
    process.exit(r.status ?? 0);
  },
  settings:       () => {
    const args = process.argv.slice(3);
    const code = require('../lib/settings-cli').run(args);
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

Options for init/reset:
  --workspace <path>      Workspace root directory (auto-detected if omitted)
  --oversight-dir <path>  Where to write generated oversight docs (default: ~/.claude/oversight)
  --private-dirs <dirs>   Comma-separated private directory names (e.g., "Personal,Financial")
  --dry-run               Show what would be done without writing files
  --skip-hooks            Don't merge hooks into settings.json
`);
  process.exit(0);
}

if (!commands[command]) {
  console.error(`Unknown command: ${command}\nRun 'rh-oversight --help' for usage.`);
  process.exit(1);
}

commands[command]();

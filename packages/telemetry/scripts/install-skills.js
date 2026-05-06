#!/usr/bin/env node
// Installs /rh-telemetry and /rh-telemetry-setup as Claude Code skills.
// Creates skill directories under ~/.claude/skills/ and generates SKILL.md files
// that invoke the project's CLI directly via absolute path (no copy, no symlink).

import { mkdir, writeFile } from 'fs/promises';
import { join, resolve, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { PORT } from '../server/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const SKILLS_DIR = join(homedir(), '.claude', 'skills');

const TELEMETRY_SKILL_DIR = join(SKILLS_DIR, 'rh-telemetry');
const SETUP_SKILL_DIR = join(SKILLS_DIR, 'rh-telemetry-setup');

async function main() {
  // Create skill directories (no scripts/ subdir — SKILL.md invokes the project's CLI directly via absolute path)
  await mkdir(TELEMETRY_SKILL_DIR, { recursive: true });
  await mkdir(SETUP_SKILL_DIR, { recursive: true });

  // SKILL.md invokes the project's CLI via absolute path. No copy. No symlink. Works for both
  // workspace-dev (PROJECT_ROOT = clone) and `npm install -g rh-telemetry` (PROJECT_ROOT =
  // node_modules/rh-telemetry). Avoids the relative-import breakage that copying alone causes.
  const cliPath = join(PROJECT_ROOT, 'scripts', 'telemetry-cli.js').replace(/\\/g, '/');

  const telemetrySkillMd = `---
name: rh-telemetry
description: Show Claude Code session stats, costs, context usage, and model breakdown inline
argument-hint: "[summary|sessions|costs|context|activity|session <name>]"
---

Here is the current Claude Code telemetry data:

\`\`\`
!\`node "${cliPath}" $ARGUMENTS\`
\`\`\`

Based on the telemetry data above, provide a clear summary to the user. Format numbers nicely and highlight anything notable (high context usage, expensive models, etc).

If the data shows "No active session" or "No sessions found", let the user know and suggest they may need to use Claude Code in a project first.

Available subcommands the user can pass as arguments:
- \`summary\` (default) — overview of active session + aggregate stats
- \`live\` — ensure telemetry server is running, then show live session data
- \`sessions\` — all project sessions sorted by cost
- \`costs\` — cost breakdown by model across all sessions
- \`context\` — context window usage details for active session
- \`activity\` — daily activity stats (last 14 days)
- \`session <name>\` — details for a specific project
`;

  await writeFile(join(TELEMETRY_SKILL_DIR, 'SKILL.md'), telemetrySkillMd);

  // Generate /telemetry-setup SKILL.md
  // Detect whether rh-telemetry is available as a global bin
  const binCmd = 'rh-telemetry';
  const projectPath = PROJECT_ROOT.replace(/\\/g, '/');

  const setupSkillMd = `---
name: rh-telemetry-setup
description: Configure Claude Code hooks and launch the telemetry web dashboard
disable-model-invocation: true
---

# Telemetry Dashboard Setup

To set up the telemetry dashboard, perform these steps:

1. **Configure hooks + install skills** (enables live tool feed, validation, prompt capture, agents):
   \`\`\`bash
   ${binCmd} setup || npx rh-telemetry setup
   \`\`\`
   If neither command works, fall back to:
   \`\`\`bash
   node "${projectPath}/scripts/setup-hooks.js" && node "${projectPath}/scripts/install-skills.js"
   \`\`\`

2. **Start the dashboard server**:
   \`\`\`bash
   ${binCmd} start --bg || npx rh-telemetry start --bg
   \`\`\`
   Or foreground:
   \`\`\`bash
   ${binCmd} start || node "${projectPath}/server/index.js"
   \`\`\`

3. **Report to the user**: The dashboard is now running at http://localhost:${PORT}

If the user asks to just configure hooks without starting the server, only run step 1.
If the user asks to just start the server, only run step 2.
`;

  await writeFile(join(SETUP_SKILL_DIR, 'SKILL.md'), setupSkillMd);

  // Write config.json with project path (useful for future reference)
  await writeFile(
    join(TELEMETRY_SKILL_DIR, 'config.json'),
    JSON.stringify({ projectPath: PROJECT_ROOT, installedAt: new Date().toISOString() }, null, 2)
  );

  // Self-test: verify the installed skill is end-to-end callable. This is the linchpin —
  // any future change that breaks the CLI's import graph fails install-skills.js immediately
  // on the developer's workstation, instead of silently in a user's next /rh-telemetry invocation.
  const { spawnSync } = await import('child_process');
  const r = spawnSync(
    process.execPath,
    [join(PROJECT_ROOT, 'scripts', 'telemetry-cli.js'), 'summary'],
    { encoding: 'utf-8', timeout: 10_000 }
  );
  if (r.status !== 0 || !/Claude Code Telemetry|No sessions found/.test(r.stdout || '')) {
    console.error('Self-test failed. Skill is installed but CLI is not invokable.');
    console.error('exit:', r.status);
    console.error('stdout:', r.stdout);
    console.error('stderr:', r.stderr);
    process.exit(1);
  }
  console.log('Self-test passed (CLI is callable end-to-end).');

  console.log('Claude Code skills installed successfully!');
  console.log('');
  console.log('Skills created:');
  console.log(`  /rh-telemetry       → ${TELEMETRY_SKILL_DIR}`);
  console.log(`  /rh-telemetry-setup → ${SETUP_SKILL_DIR}`);
  console.log('');
  console.log('Usage:');
  console.log('  /rh-telemetry              — show session summary inline');
  console.log('  /rh-telemetry sessions     — list all sessions by cost');
  console.log('  /rh-telemetry costs        — cost breakdown by model');
  console.log('  /rh-telemetry context      — context window details');
  console.log('  /rh-telemetry activity     — daily activity stats');
  console.log('  /rh-telemetry session X    — details for project X');
  console.log('  /rh-telemetry-setup        — configure hooks & launch dashboard');
  console.log('');
  console.log('Start a new Claude Code session to use these skills.');
}

main().catch((err) => {
  console.error('Failed to install skills:', err.message);
  process.exit(1);
});
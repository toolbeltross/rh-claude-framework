#!/usr/bin/env node
// Installs /telemetry and /telemetry-setup as Claude Code skills.
// Creates skill directories under ~/.claude/skills/ and generates SKILL.md files.

import { mkdir, copyFile, writeFile } from 'fs/promises';
import { join, resolve, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { PORT } from '../server/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const SKILLS_DIR = join(homedir(), '.claude', 'skills');

const TELEMETRY_SKILL_DIR = join(SKILLS_DIR, 'telemetry');
const SETUP_SKILL_DIR = join(SKILLS_DIR, 'telemetry-setup');

async function main() {
  // Create skill directories
  await mkdir(join(TELEMETRY_SKILL_DIR, 'scripts'), { recursive: true });
  await mkdir(SETUP_SKILL_DIR, { recursive: true });

  // Copy the standalone CLI script into the telemetry skill
  await copyFile(
    join(PROJECT_ROOT, 'scripts', 'telemetry-cli.js'),
    join(TELEMETRY_SKILL_DIR, 'scripts', 'telemetry-cli.js')
  );

  // Generate /telemetry SKILL.md
  // Uses !`command` for dynamic context injection — runs before Claude sees the prompt
  const cliPath = join(TELEMETRY_SKILL_DIR, 'scripts', 'telemetry-cli.js').replace(/\\/g, '/');

  const telemetrySkillMd = `---
name: telemetry
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
name: telemetry-setup
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

  console.log('Claude Code skills installed successfully!');
  console.log('');
  console.log('Skills created:');
  console.log(`  /telemetry       → ${TELEMETRY_SKILL_DIR}`);
  console.log(`  /telemetry-setup → ${SETUP_SKILL_DIR}`);
  console.log('');
  console.log('Usage:');
  console.log('  /telemetry              — show session summary inline');
  console.log('  /telemetry sessions     — list all sessions by cost');
  console.log('  /telemetry costs        — cost breakdown by model');
  console.log('  /telemetry context      — context window details');
  console.log('  /telemetry activity     — daily activity stats');
  console.log('  /telemetry session X    — details for project X');
  console.log('  /telemetry-setup        — configure hooks & launch dashboard');
  console.log('');
  console.log('Start a new Claude Code session to use these skills.');
}

main().catch((err) => {
  console.error('Failed to install skills:', err.message);
  process.exit(1);
});
// init.js — installs the oversight framework to ~/.claude/ and merges hooks into settings.json.

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const PKG_ROOT = path.join(__dirname, '..');

function parseArgs() {
  const args = process.argv.slice(3);
  const opts = { dryRun: false, skipHooks: false, reset: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--workspace' && args[i + 1]) opts.workspace = args[++i];
    else if (args[i] === '--oversight-dir' && args[i + 1]) opts.oversightDir = args[++i];
    else if (args[i] === '--private-dirs' && args[i + 1]) opts.privateDirs = args[++i].split(',').map(s => s.trim());
    else if (args[i] === '--dry-run') opts.dryRun = true;
    else if (args[i] === '--skip-hooks') opts.skipHooks = true;
  }
  return opts;
}

function copyDir(src, dest, opts) {
  if (!fs.existsSync(src)) return 0;
  if (!opts.dryRun && !fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      count += copyDir(srcPath, destPath, opts);
    } else {
      if (opts.dryRun) { console.log(`  [dry-run] copy ${srcPath} → ${destPath}`); }
      else { fs.copyFileSync(srcPath, destPath); }
      count++;
    }
  }
  return count;
}

function resolveTemplate(templateContent, vars) {
  let result = templateContent;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }
  return result;
}

function mergeHooks(settingsPath, templatePath, vars, opts) {
  const templateRaw = fs.readFileSync(templatePath, 'utf8');
  const resolved = resolveTemplate(templateRaw, vars);
  let templateSettings;
  try { templateSettings = JSON.parse(resolved); } catch (e) {
    console.error(`  ERROR: failed to parse resolved settings template: ${e.message}`);
    return;
  }

  let existing = {};
  if (fs.existsSync(settingsPath)) {
    try { existing = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {
      console.error(`  WARNING: existing settings.json is malformed; backing up and overwriting.`);
      if (!opts.dryRun) fs.copyFileSync(settingsPath, settingsPath + '.backup');
    }
  }

  // Merge env vars (additive)
  existing.env = { ...(existing.env || {}), ...(templateSettings.env || {}) };

  // Merge hooks (replace by matcher key — don't duplicate)
  const existingHooks = existing.hooks || {};
  const templateHooks = templateSettings.hooks || {};

  for (const [phase, entries] of Object.entries(templateHooks)) {
    if (!existingHooks[phase]) { existingHooks[phase] = entries; continue; }
    for (const newEntry of entries) {
      const matcher = newEntry.matcher || '*';
      const existingIdx = existingHooks[phase].findIndex(e => (e.matcher || '*') === matcher);
      if (existingIdx >= 0) {
        existingHooks[phase][existingIdx] = newEntry;
      } else {
        existingHooks[phase].push(newEntry);
      }
    }
  }

  existing.hooks = existingHooks;

  if (opts.dryRun) {
    console.log(`  [dry-run] would write merged hooks to ${settingsPath}`);
    console.log(`  [dry-run] hook phases: ${Object.keys(existingHooks).join(', ')}`);
  } else {
    fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');
    console.log(`  Merged hooks into ${settingsPath}`);
  }
}

function run(extraOpts = {}) {
  const opts = { ...parseArgs(), ...extraOpts };
  const configModule = require(path.join(PKG_ROOT, 'scripts', 'lib', 'config'));

  console.log('\nrh-oversight init');
  console.log('─'.repeat(40));

  // Detect or use provided workspace
  const workspace = opts.workspace || configModule.autoDetectWorkspace();
  const oversightDir = opts.oversightDir || path.join(CLAUDE_DIR, 'oversight');
  const scriptsDir = path.join(CLAUDE_DIR, 'scripts');
  const agentsDir = path.join(CLAUDE_DIR, 'agents');
  const skillsDir = path.join(CLAUDE_DIR, 'skills');
  const rulesDir = path.join(workspace, '.claude', 'rules');

  console.log(`  Home:          ${HOME}`);
  console.log(`  Workspace:     ${workspace}`);
  console.log(`  Oversight dir: ${oversightDir}`);
  console.log(`  Scripts dir:   ${scriptsDir}`);
  console.log(`  Agents dir:    ${agentsDir}`);
  console.log(`  Rules dir:     ${rulesDir}`);
  console.log('');

  // 1. Write oversight.json config
  const configData = {
    workspace,
    oversightDir,
    telemetryPort: 7890,
    userName: process.env.USER || process.env.USERNAME || path.basename(HOME),
  };
  if (opts.privateDirs) configData.privateDirs = opts.privateDirs;

  const configPath = path.join(CLAUDE_DIR, 'oversight.json');
  if (opts.reset && fs.existsSync(configPath)) {
    console.log('  [reset] Preserving existing oversight.json');
  } else {
    if (opts.dryRun) console.log(`  [dry-run] would write ${configPath}`);
    else {
      if (!fs.existsSync(CLAUDE_DIR)) fs.mkdirSync(CLAUDE_DIR, { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(configData, null, 2) + '\n', 'utf8');
      console.log(`  Wrote ${configPath}`);
    }
  }

  // 2. Copy scripts
  if (opts.reset) {
    const existing = fs.readdirSync(scriptsDir).filter(f => f.startsWith('rh-'));
    if (!opts.dryRun) for (const f of existing) fs.unlinkSync(path.join(scriptsDir, f));
    console.log(`  [reset] Removed ${existing.length} existing rh-* scripts`);
  }
  const scriptCount = copyDir(path.join(PKG_ROOT, 'scripts'), scriptsDir, opts);
  console.log(`  Copied ${scriptCount} script files → ${scriptsDir}`);

  // 3. Copy agents
  const agentCount = copyDir(path.join(PKG_ROOT, 'agents'), agentsDir, opts);
  console.log(`  Copied ${agentCount} agent files → ${agentsDir}`);

  // 4. Copy skills
  const skillCount = copyDir(path.join(PKG_ROOT, 'skills'), skillsDir, opts);
  console.log(`  Copied ${skillCount} skill files → ${skillsDir}`);

  // 5. Copy rules
  const ruleCount = copyDir(path.join(PKG_ROOT, 'rules'), rulesDir, opts);
  console.log(`  Copied ${ruleCount} rule files → ${rulesDir}`);

  // 6. Create oversight dir
  if (!opts.dryRun && !fs.existsSync(oversightDir)) {
    fs.mkdirSync(oversightDir, { recursive: true });
    console.log(`  Created ${oversightDir}`);
  }

  // 7. Merge hooks into settings.json
  if (!opts.skipHooks) {
    const templatePath = path.join(PKG_ROOT, 'templates', 'settings.json.template');
    const vars = {
      SCRIPTS_DIR: scriptsDir.replace(/\\/g, '/'),
      OVERSIGHT_DIR: oversightDir.replace(/\\/g, '/'),
    };
    mergeHooks(path.join(CLAUDE_DIR, 'settings.json'), templatePath, vars, opts);
  } else {
    console.log('  [skip-hooks] Skipped hook merge');
  }

  // 8. Generate CLAUDE.md if none exists at workspace root
  const workspaceClaude = path.join(workspace, 'CLAUDE.md');
  if (!fs.existsSync(workspaceClaude)) {
    const templatePath = path.join(PKG_ROOT, 'templates', 'CLAUDE.md.template');
    if (fs.existsSync(templatePath)) {
      const template = fs.readFileSync(templatePath, 'utf8');
      const vars = {
        DOMAIN_TABLE: '| Projects | `projects/` | default | Your projects |',
        WORKSPACE: workspace,
        USER: configData.userName,
      };
      if (opts.dryRun) console.log(`  [dry-run] would write ${workspaceClaude}`);
      else {
        fs.writeFileSync(workspaceClaude, resolveTemplate(template, vars), 'utf8');
        console.log(`  Wrote starter ${workspaceClaude}`);
      }
    }
  } else {
    console.log(`  CLAUDE.md already exists at workspace root — skipped`);
  }

  console.log('\n  Done. Run `rh-oversight self-test` to verify.\n');
}

module.exports = { run };

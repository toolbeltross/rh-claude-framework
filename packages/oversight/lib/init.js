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

/**
 * Pure merge logic — given existing hooks object + template hooks object,
 * return the merged result. Extracted from mergeHooks() for testability.
 *
 * MERGE SEMANTICS (revised 2026-05-06 to fix F-10 root cause):
 *
 * For each phase in the template:
 *   - If no existing entries for the phase → take the template entries verbatim
 *   - For each template entry:
 *     - If an existing entry with the same matcher exists → MERGE per-hook into
 *       it. Template hooks whose command/prompt content already appears in the
 *       existing entry's hooks are no-ops (idempotent re-run). Template hooks
 *       not yet present are appended to the existing entry's hooks array.
 *       Foreign hooks (those in existing but not in template) are PRESERVED.
 *     - If no existing entry has the same matcher → append the template entry.
 *
 * Why per-hook (not per-entry) is the right granularity:
 * The 2026-05-04 incident (F-10) was: rh-telemetry's setup-hooks.js had added
 * `hook-forwarder.js stop` to the Stop chain, then this merge logic ran on a
 * fresh settings.json (file recreated) and produced a Stop chain WITHOUT
 * hook-forwarder.js stop. The supervisory log silently went 3 days without
 * entries before manual investigation surfaced it.
 *
 * The fix preserves any hook the existing chain already has (telemetry's, the
 * user's manual additions, etc.) while still applying the template's own hooks
 * idempotently. See OVERSIGHT_SYSTEM.md F-10 and PROGRESS.md item 11 for
 * background. Test coverage: tests/test-init-merge.js.
 */
function mergeHooksData(existingHooks, templateHooks) {
  // Identity for an individual hook within a chain — based on what makes it
  // observably the same. Two hooks with the same command string are treated
  // as the same hook regardless of the type field.
  //
  // Special case: Layer 3a supervisory prompts. rh-oversight and rh-telemetry
  // both add a Stop-phase prompt-type hook whose body begins
  // "ADDITIVE ONLY — Layer 3a narrow supervisory review". The exact wording
  // can drift between packages over time (rule edits, comment tweaks). Hashing
  // the full prompt body would treat those two near-identical prompts as
  // distinct hooks, producing TWO Layer 3a prompt firings per Stop in some
  // install orderings (telemetry-first followed by oversight init). That
  // doubles the per-turn cost and gives the model two judgments to reconcile.
  //
  // Detect Layer 3a prompts by signature ("ADDITIVE ONLY" + "Layer 3a") and
  // collapse them to a single synthetic key. Other prompt-type hooks still
  // dedupe by body, preserving the existing per-turn-prompt behavior.
  function hookKey(h) {
    if (!h) return '';
    if (h.type === 'prompt' && typeof h.prompt === 'string' &&
        h.prompt.includes('ADDITIVE ONLY') && h.prompt.includes('Layer 3a')) {
      return '__layer3a_supervisory_prompt__';
    }
    return h.command || h.prompt || JSON.stringify(h);
  }
  // Identity for an entry — the matcher (or '*' for matcherless entries).
  // We merge per-hook within entries that share a matcher.
  function entryMatcher(entry) {
    return entry.matcher || '*';
  }

  // Shallow clone so callers' input objects aren't mutated.
  const result = {};
  for (const [phase, entries] of Object.entries(existingHooks)) {
    result[phase] = entries.map(e => ({
      ...e,
      hooks: [...(e.hooks || [])],
    }));
  }

  for (const [phase, templateEntries] of Object.entries(templateHooks)) {
    if (!result[phase]) {
      result[phase] = templateEntries.map(e => ({ ...e, hooks: [...(e.hooks || [])] }));
      continue;
    }
    for (const newEntry of templateEntries) {
      const newMatcher = entryMatcher(newEntry);
      const existingEntryIdx = result[phase].findIndex(e => entryMatcher(e) === newMatcher);

      if (existingEntryIdx === -1) {
        // No existing entry with this matcher — add as a new entry
        result[phase].push({ ...newEntry, hooks: [...(newEntry.hooks || [])] });
        continue;
      }

      // Same matcher — merge hooks per-hook. Foreign hooks are preserved.
      const existingEntry = result[phase][existingEntryIdx];
      const existingHookKeys = new Set((existingEntry.hooks || []).map(hookKey));
      const newHooksToAdd = (newEntry.hooks || []).filter(h => !existingHookKeys.has(hookKey(h)));
      existingEntry.hooks = [...(existingEntry.hooks || []), ...newHooksToAdd];
    }
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

  // Merge env vars (additive — user's existing values WIN over template defaults).
  // The spread order is intentional: user customizations like OVERSIGHT_LOG_PATH
  // pointing at a custom workspace path must not be overwritten on re-init.
  existing.env = { ...(templateSettings.env || {}), ...(existing.env || {}) };

  // Merge hooks via the pure mergeHooksData function (per-hook additive merge).
  existing.hooks = mergeHooksData(existing.hooks || {}, templateSettings.hooks || {});

  // P2-4 pre-write validation gate. Runs on the FULLY MERGED settings object,
  // not the template, so the gate catches issues introduced by the merge
  // itself (e.g., shape-bad existing entries that survived the merge). Errors
  // block the write; warnings are surfaced but allow the write so the gate
  // doesn't refuse to install on a soft inconsistency the user already has.
  const { validateSettings, formatIssues } = require(path.join(PKG_ROOT, 'scripts', 'lib', 'settings-validator'));
  const validation = validateSettings(existing);
  if (validation.errors.length > 0) {
    console.error(`  ERROR: merged settings.json failed validation — refusing to write`);
    console.error(formatIssues(validation).split('\n').map(l => '    ' + l).join('\n'));
    console.error(`  Aborted. No file written. Existing settings.json at ${settingsPath} is unchanged.`);
    return;
  }
  if (validation.warnings.length > 0 && !opts.dryRun) {
    console.log(`  Validation passed with ${validation.warnings.length} warning(s):`);
    for (const w of validation.warnings) console.log(`    ⚠ [${w.code}] ${w.path}: ${w.message}`);
  }

  if (opts.dryRun) {
    console.log(`  [dry-run] would write merged hooks to ${settingsPath}`);
    console.log(`  [dry-run] hook phases: ${Object.keys(existing.hooks).join(', ')}`);
    if (validation.warnings.length > 0) {
      console.log(`  [dry-run] ${validation.warnings.length} validation warning(s):`);
      for (const w of validation.warnings) console.log(`    ⚠ [${w.code}] ${w.path}: ${w.message}`);
    }
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

module.exports = { run, mergeHooksData };

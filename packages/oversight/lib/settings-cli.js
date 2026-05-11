// lib/settings-cli.js
//
// rh-oversight settings — merge-aware CLI for ~/.claude/settings.json.
//
// Subcommands:
//   validate [path]        — schema validation against settings-validator.js
//   show                   — display current settings + validation issues
//   diff <other>           — show what would change if <other> were merged in (no write)
//   merge <other>          — merge <other> into current; --dry-run (default) or --apply
//   backup [--out <path>]  — timestamped backup of current settings.json
//   restore <backup>       — replace current settings.json with the named backup (validates first)
//
// Default subject is ~/.claude/settings.json. --path <p> overrides on any subcommand.
//
// Exit codes:
//   0  — operation succeeded (or no-op in dry-run)
//   1  — validation errors / refusal to write
//   2  — bad usage
//   3  — IO error

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const DEFAULT_SETTINGS = path.join(HOME, '.claude', 'settings.json');

const { validateFile, validateSettings, formatIssues } = require('../scripts/lib/settings-validator');
const { mergeHooksData } = require('./init');

function parseArgs(argv) {
  const args = argv.slice(0);
  const opts = { dryRun: true, apply: false };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--path' && args[i + 1]) opts.path = args[++i];
    else if (args[i] === '--out' && args[i + 1]) opts.out = args[++i];
    else if (args[i] === '--dry-run') { opts.dryRun = true; opts.apply = false; }
    else if (args[i] === '--apply') { opts.apply = true; opts.dryRun = false; }
    else if (args[i] === '--json') opts.json = true;
    else positional.push(args[i]);
  }
  return { opts, positional };
}

function readJsonFile(p) {
  const raw = fs.readFileSync(p, 'utf8');
  return JSON.parse(raw);
}

function targetPath(opts) {
  return opts.path || DEFAULT_SETTINGS;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
}

// ── validate ─────────────────────────────────────────────────────────────
function cmdValidate(positional, opts) {
  const p = positional[0] || targetPath(opts);
  if (!fs.existsSync(p)) {
    console.error(`File not found: ${p}`);
    return 3;
  }
  const result = validateFile(fs, p);
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`settings: ${p}`);
    console.log(formatIssues(result));
  }
  return result.ok ? 0 : 1;
}

// ── show ─────────────────────────────────────────────────────────────────
function cmdShow(_positional, opts) {
  const p = targetPath(opts);
  if (!fs.existsSync(p)) {
    console.error(`File not found: ${p}`);
    return 3;
  }
  const result = validateFile(fs, p);
  if (result.parseError) {
    console.error(`Parse error: ${result.parseError.message}`);
    return 1;
  }
  // Re-parse for inspection (validateFile doesn't expose parsed obj).
  let parsed;
  try { parsed = readJsonFile(p); }
  catch (e) { console.error(`Read error: ${e.message}`); return 3; }
  if (opts.json) {
    console.log(JSON.stringify({ path: p, settings: parsed, validation: result }, null, 2));
    return result.ok ? 0 : 1;
  }
  console.log(`settings: ${p}`);
  console.log(`size: ${fs.statSync(p).size} bytes`);
  console.log(`model: ${parsed.model || '(default)'}`);
  console.log(`env keys: ${parsed.env ? Object.keys(parsed.env).length : 0}`);
  if (parsed.hooks) {
    console.log(`hooks phases:`);
    for (const [phase, entries] of Object.entries(parsed.hooks)) {
      const itemCount = Array.isArray(entries)
        ? entries.reduce((n, e) => n + (Array.isArray(e?.hooks) ? e.hooks.length : 0), 0)
        : 0;
      console.log(`  ${phase}: ${Array.isArray(entries) ? entries.length : '?'} entries, ${itemCount} hooks`);
    }
  }
  console.log('');
  console.log(formatIssues(result));
  return result.ok ? 0 : 1;
}

// ── diff ─────────────────────────────────────────────────────────────────
// Show what the Stop/PreToolUse/etc. chains would look like AFTER mergeHooksData
// is applied. Doesn't write anything.
function cmdDiff(positional, opts) {
  const other = positional[0];
  if (!other) { console.error('usage: rh-oversight settings diff <other-settings.json>'); return 2; }
  const target = targetPath(opts);
  if (!fs.existsSync(target)) { console.error(`File not found: ${target}`); return 3; }
  if (!fs.existsSync(other)) { console.error(`File not found: ${other}`); return 3; }

  let current, incoming;
  try { current = readJsonFile(target); incoming = readJsonFile(other); }
  catch (e) { console.error(`Parse error: ${e.message}`); return 1; }

  const before = current.hooks || {};
  const merged = mergeHooksData(before, incoming.hooks || {});

  if (opts.json) {
    console.log(JSON.stringify({ before, merged }, null, 2));
    return 0;
  }
  console.log(`current: ${target}`);
  console.log(`incoming: ${other}`);
  console.log('');
  const allPhases = new Set([...Object.keys(before), ...Object.keys(merged)]);
  for (const phase of allPhases) {
    const beforeCount = (before[phase] || []).reduce((n, e) => n + (e?.hooks?.length || 0), 0);
    const afterCount = (merged[phase] || []).reduce((n, e) => n + (e?.hooks?.length || 0), 0);
    const sign = afterCount > beforeCount ? '+' : (afterCount < beforeCount ? '-' : ' ');
    console.log(`  ${sign} ${phase}: ${beforeCount} → ${afterCount} hook items`);
  }
  // Validate post-merge result
  const v = validateSettings({ ...current, hooks: merged });
  console.log('');
  console.log('Post-merge validation:');
  console.log(formatIssues(v));
  return v.ok ? 0 : 1;
}

// ── merge ────────────────────────────────────────────────────────────────
// Apply mergeHooksData and write. Dry-run by default; --apply required to write.
function cmdMerge(positional, opts) {
  const other = positional[0];
  if (!other) { console.error('usage: rh-oversight settings merge <other-settings.json> [--apply]'); return 2; }
  const target = targetPath(opts);
  if (!fs.existsSync(target)) { console.error(`File not found: ${target}`); return 3; }
  if (!fs.existsSync(other)) { console.error(`File not found: ${other}`); return 3; }

  let current, incoming;
  try { current = readJsonFile(target); incoming = readJsonFile(other); }
  catch (e) { console.error(`Parse error: ${e.message}`); return 1; }

  // Env merge follows init.js convention (existing wins over incoming defaults)
  const mergedEnv = { ...(incoming.env || {}), ...(current.env || {}) };
  const mergedHooks = mergeHooksData(current.hooks || {}, incoming.hooks || {});
  const result = { ...current, env: mergedEnv, hooks: mergedHooks };

  const v = validateSettings(result);
  if (!v.ok) {
    console.error(`Merge result failed validation — refusing to write`);
    console.error(formatIssues(v));
    return 1;
  }
  if (v.warnings.length) {
    console.log(`Warnings (${v.warnings.length}):`);
    for (const w of v.warnings) console.log(`  ⚠ [${w.code}] ${w.path}: ${w.message}`);
  }

  if (!opts.apply) {
    console.log(`[dry-run] merge OK; ${countHooks(result.hooks)} total hook items across ${Object.keys(result.hooks).length} phases.`);
    console.log(`[dry-run] re-run with --apply to write to ${target}`);
    return 0;
  }

  // Backup before writing
  const backupPath = `${target}.bak.${timestamp()}`;
  fs.copyFileSync(target, backupPath);
  fs.writeFileSync(target, JSON.stringify(result, null, 2) + '\n', 'utf8');
  console.log(`Wrote merged settings to ${target}`);
  console.log(`Backup at ${backupPath}`);
  return 0;
}

function countHooks(hooks) {
  let n = 0;
  for (const entries of Object.values(hooks || {})) {
    for (const e of entries || []) n += (e?.hooks?.length || 0);
  }
  return n;
}

// ── backup ───────────────────────────────────────────────────────────────
function cmdBackup(_positional, opts) {
  const target = targetPath(opts);
  if (!fs.existsSync(target)) { console.error(`File not found: ${target}`); return 3; }
  const dest = opts.out || `${target}.bak.${timestamp()}`;
  fs.copyFileSync(target, dest);
  console.log(`Backup written: ${dest}`);
  return 0;
}

// ── restore ──────────────────────────────────────────────────────────────
function cmdRestore(positional, opts) {
  const backup = positional[0];
  if (!backup) { console.error('usage: rh-oversight settings restore <backup-file>'); return 2; }
  if (!fs.existsSync(backup)) { console.error(`Backup not found: ${backup}`); return 3; }
  // Validate the backup BEFORE replacing the live file
  const v = validateFile(fs, backup);
  if (!v.ok) {
    console.error(`Backup file failed validation — refusing to restore`);
    console.error(formatIssues(v));
    return 1;
  }
  const target = targetPath(opts);
  if (fs.existsSync(target)) {
    const safety = `${target}.pre-restore.${timestamp()}`;
    fs.copyFileSync(target, safety);
    console.log(`Safety copy of pre-restore settings: ${safety}`);
  }
  fs.copyFileSync(backup, target);
  console.log(`Restored ${target} from ${backup}`);
  return 0;
}

function help() {
  console.log(`
rh-oversight settings — merge-aware CLI for settings.json

Usage:
  rh-oversight settings <subcommand> [args] [--path <settings.json>]

Subcommands:
  validate [path]               Validate schema of file (default: ~/.claude/settings.json)
  show                          Show current settings summary + validation
  diff <other>                  Show what changes if <other> were merged in
  merge <other> [--apply]       Merge <other> into current (dry-run unless --apply)
  backup [--out <path>]         Timestamped backup
  restore <backup>              Replace current with <backup> (after validating backup)

Options:
  --path <p>     Override default ~/.claude/settings.json
  --json         JSON output where supported
  --apply        Required to actually write in 'merge' (default is dry-run)

Exit codes: 0=ok, 1=validation/refusal, 2=usage, 3=IO`);
}

function run(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  const { opts, positional } = parseArgs(rest);

  switch (sub) {
    case 'validate': return cmdValidate(positional, opts);
    case 'show':     return cmdShow(positional, opts);
    case 'diff':     return cmdDiff(positional, opts);
    case 'merge':    return cmdMerge(positional, opts);
    case 'backup':   return cmdBackup(positional, opts);
    case 'restore':  return cmdRestore(positional, opts);
    case '--help': case '-h': case undefined: help(); return 0;
    default:
      console.error(`Unknown settings subcommand: ${sub}`);
      help();
      return 2;
  }
}

module.exports = { run };

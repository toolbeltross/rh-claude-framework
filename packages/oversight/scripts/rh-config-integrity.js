#!/usr/bin/env node
/**
 * rh-config-integrity.js
 *
 * Detect-only integrity check for the Claude config surface. Answers one
 * question: "is everything the live oversight/telemetry system depends on
 * actually present, readable, and un-corrupted on disk — or has OneDrive /
 * an OS-level problem silently broken it?"
 *
 * Run via:
 *   node ~/.claude/scripts/rh-config-integrity.js          — pretty text
 *   node ~/.claude/scripts/rh-config-integrity.js --json    — machine output
 *
 * Wired into /rh-quit (session-end) so a OneDrive/OS regression surfaces
 * before the session closes. ALERT-ONLY by design: it never modifies,
 * re-pins, or repairs anything — it prints what is wrong and the suggested
 * fix command for the user to run.
 *
 * Exit codes:
 *   0 = clean
 *   1 = degraded (warnings — sync conflicts, JSON soft-parse, etc.)
 *   2 = critical (a file the live config depends on is missing / cloud-only /
 *       zero-byte, or user settings.json does not parse)
 *
 * Fills the gap left by the existing suite: rh-oversight-self-test.js checks
 * hook *behavior*, rh-oversight-health.js checks journal *freshness* — neither
 * checks OneDrive dehydration, config-file integrity, or whether the scripts
 * referenced by settings.json actually exist on disk.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { config } = require('./lib/config');

const JSON_OUT = process.argv.includes('--json');
const IS_WIN = process.platform === 'win32';

// Subdirs that legitimately hold regenerable / intentionally-empty / huge
// content — excluded from the integrity walk so we don't false-alarm.
const EXCLUDE_RE = /[\\/](node_modules|\.git|worktrees|tmp|\.playwright-mcp|backups|read-warn-markers|projects)[\\/]/i;

// A zero-byte file is only suspicious for these "must have content" types.
const CONTENTFUL_EXT = new Set(['.js', '.cjs', '.mjs', '.json', '.md']);

// ─── Helpers ─────────────────────────────────────────────────────────────

function fileExists(p) { try { fs.accessSync(p); return true; } catch { return false; } }
function fileSize(p) { try { return fs.statSync(p).size; } catch { return -1; } }
function statusGlyph(level) {
  return { ok: '[OK]', warn: '[WARN]', crit: '[CRIT]', info: '[--]' }[level] || '[?]';
}

// The OneDrive-synced + user config dirs the live system depends on.
function criticalDirs() {
  const dirs = [
    path.join(config.workspace, '.claude'),   // rules / agents / skills / commands / settings (OneDrive)
    config.oversightDir,                       // oversight design + state docs (OneDrive)
    config.scriptsDir,                         // ~/.claude/scripts (hooks/guards)
    config.agentsDir,                          // ~/.claude/agents
    config.skillsDir,                          // ~/.claude/skills
  ];
  return [...new Set(dirs.filter(Boolean).filter(fileExists))];
}

// Pull every script path a hook command references out of a settings object.
//
// Parses the JSON and walks command strings so QUOTED paths that contain a
// space are captured intact — e.g. `node "C:/Users/First Last/.claude/scripts/
// rh-x.js"`. The previous raw-text regex had no space in its character class,
// so a home path with a space (very common: `C:\Users\First Last`, OneDrive)
// made every hook look "missing" — a false CRITICAL at every session close.
// Falls back to the legacy raw scan only if the settings JSON won't parse.
function collectScriptRefs(settingsRaw) {
  const refs = new Set();
  const addPath = (p) => {
    if (!p) return;
    p = p
      .replace(/^~/, config.home)
      .replace(/\$HOME|\$\{HOME\}/g, config.home)
      .replace(/\$CLAUDE_PROJECT_DIR|\$\{CLAUDE_PROJECT_DIR\}/g, config.claudeDir);
    refs.add(path.normalize(p));
  };
  const fromCommand = (cmd) => {
    if (typeof cmd !== 'string') return;
    let m;
    // Quoted paths first (may contain spaces): node "…/x.js" arg
    const quoted = /"([^"]*\.(?:js|cjs|mjs))"/g;
    while ((m = quoted.exec(cmd)) !== null) addPath(m[1]);
    // Then unquoted tokens (no spaces) on the de-quoted remainder.
    const stripped = cmd.replace(/"[^"]*"/g, ' ');
    const unquoted = /(?:^|\s)([^\s"]+\.(?:js|cjs|mjs))(?=\s|$)/g;
    while ((m = unquoted.exec(stripped)) !== null) addPath(m[1]);
  };

  let parsed = null;
  try { parsed = JSON.parse(settingsRaw); } catch { /* fall through to legacy scan */ }
  if (parsed && parsed.hooks && typeof parsed.hooks === 'object') {
    for (const phase of Object.values(parsed.hooks)) {
      if (!Array.isArray(phase)) continue;
      for (const entry of phase) for (const h of (entry && entry.hooks) || []) fromCommand(h && h.command);
    }
    if (parsed.statusLine && parsed.statusLine.command) fromCommand(parsed.statusLine.command);
    return [...refs];
  }
  // Fallback: settings.json unparseable — best-effort legacy scan (no spaces).
  const re = /[A-Za-z0-9_.~$:\\/\-]+\.(?:js|cjs|mjs)\b/g;
  let m;
  while ((m = re.exec(settingsRaw)) !== null) addPath(m[0]);
  return [...refs];
}

// Recursive node walk (metadata only — statSync does NOT hydrate cloud files).
function walkCritical(dirs) {
  const all = [];
  for (const root of dirs) {
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        // Match the exclusion against the path RELATIVE to the critical root, so
        // a throwaway subdir (tmp/, backups/, projects/, …) INSIDE the tree is
        // skipped WITHOUT an incidental segment in the absolute prefix knocking
        // out the whole scan — e.g. a workspace under ~/projects/… or the OS
        // temp dir (/tmp/… on Linux, where the tests stage their fixtures).
        const rel = path.sep + path.relative(root, full) + path.sep;
        if (EXCLUDE_RE.test(rel)) continue;
        if (e.isDirectory()) stack.push(full);
        else if (e.isFile()) all.push(full);
      }
    }
  }
  return all;
}

// Windows-only: which of these files are cloud-only (OFFLINE 0x1000 or
// RECALL_ON_DATA_ACCESS 0x400000)? Enumerating .Attributes reads metadata
// only and does not trigger a download. Returns [] on non-Windows.
function scanDehydrated(dirs) {
  if (!IS_WIN || dirs.length === 0) return [];
  const psArray = dirs.map(d => "'" + String(d).replace(/'/g, "''") + "'").join(',');
  const ps =
    "$ErrorActionPreference='SilentlyContinue';" +
    `$dirs=@(${psArray});` +
    "$o=foreach($d in $dirs){ if(Test-Path -LiteralPath $d){ Get-ChildItem -LiteralPath $d -Recurse -File -Force |" +
    " Where-Object { ($_.Attributes -band 0x1000) -or ($_.Attributes -band 0x400000) } |" +
    " ForEach-Object { $_.FullName } } };" +
    "if($o){ $o | ConvertTo-Json -Compress } else { '[]' }";
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { encoding: 'utf8', timeout: 30000 }).trim();
    if (!out) return [];
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return null; // signal: probe could not run
  }
}

// ─── Probes ──────────────────────────────────────────────────────────────

// 1. Every settings/config JSON parses.
function probeJsonValidity() {
  const targets = [
    { p: config.settingsPath, crit: true,  label: 'settings.json' },
    { p: path.join(config.claudeDir, 'settings.local.json'), crit: false, label: 'settings.local.json' },
    { p: config.configPath, crit: false, label: 'oversight.json' },
    { p: path.join(config.workspace, '.claude', 'settings.json'), crit: false, label: 'workspace settings.json' },
    { p: path.join(config.workspace, '.claude', 'settings.local.json'), crit: false, label: 'workspace settings.local.json' },
  ];
  const bad = [];
  let checked = 0;
  for (const t of targets) {
    if (!fileExists(t.p)) continue;
    checked++;
    try { JSON.parse(fs.readFileSync(t.p, 'utf8')); }
    catch (e) { bad.push({ ...t, err: e.message }); }
  }
  if (bad.length === 0) return { name: 'json-validity', level: 'ok', detail: `${checked} config files parse cleanly` };
  const level = bad.some(b => b.crit) ? 'crit' : 'warn';
  return { name: 'json-validity', level, detail: `INVALID: ${bad.map(b => b.label).join(', ')}`, bad };
}

// 2. Every script a hook references exists and is non-empty.
function probeHookReferences() {
  if (!fileExists(config.settingsPath)) return { name: 'hook-references', level: 'crit', detail: 'settings.json missing' };
  const raw = fs.readFileSync(config.settingsPath, 'utf8');
  const refs = collectScriptRefs(raw);
  const missing = [], empty = [];
  for (const r of refs) {
    const sz = fileSize(r);
    if (sz < 0) missing.push(r);
    else if (sz === 0) empty.push(r);
  }
  if (missing.length === 0 && empty.length === 0)
    return { name: 'hook-references', level: 'ok', detail: `${refs.length} referenced scripts present & non-empty` };
  const level = missing.length ? 'crit' : 'warn';
  const detail = [
    missing.length ? `MISSING ${missing.length}: ${missing.map(p => path.basename(p)).join(', ')}` : '',
    empty.length ? `ZERO-BYTE ${empty.length}: ${empty.map(p => path.basename(p)).join(', ')}` : '',
  ].filter(Boolean).join(' · ');
  return { name: 'hook-references', level, detail, missing, empty };
}

// 3. OneDrive dehydration — any critical config that is cloud-only.
function probeOneDriveHydration(dirs) {
  if (!IS_WIN) return { name: 'onedrive-hydration', level: 'info', detail: 'not Windows — N/A' };
  const bad = scanDehydrated(dirs);
  if (bad === null) return { name: 'onedrive-hydration', level: 'warn', detail: 'probe could not run (powershell unavailable?)' };
  if (bad.length === 0) return { name: 'onedrive-hydration', level: 'ok', detail: 'all critical config is local (pinned / hydrated)' };
  return {
    name: 'onedrive-hydration', level: 'crit',
    detail: `${bad.length} CLOUD-ONLY: ${bad.slice(0, 8).map(p => path.basename(p)).join(', ')}` + (bad.length > 8 ? ' …' : ''),
    files: bad,
  };
}

// 4. Zero-byte contentful config files (.js/.json/.md that should never be empty).
function probeZeroByteConfig(allFiles) {
  const zero = allFiles.filter(f => CONTENTFUL_EXT.has(path.extname(f).toLowerCase()) && fileSize(f) === 0);
  if (zero.length === 0) return { name: 'zero-byte-config', level: 'ok', detail: 'no empty .js/.json/.md config files' };
  return {
    name: 'zero-byte-config', level: 'crit',
    detail: `${zero.length} EMPTY: ${zero.slice(0, 8).map(p => path.basename(p)).join(', ')}` + (zero.length > 8 ? ' …' : ''),
    files: zero,
  };
}

// 5. OneDrive sync-conflict files in the critical trees.
function probeSyncConflicts(allFiles) {
  const host = (os.hostname() || '').split('.')[0].replace(/[^A-Za-z0-9_-]/g, '');
  const hostRe = host ? new RegExp('-' + host + '[ .]', 'i') : null;
  const conflicts = allFiles.filter(f => {
    const n = path.basename(f);
    return /conflicted copy/i.test(n) || (hostRe && hostRe.test(n));
  });
  if (conflicts.length === 0) return { name: 'sync-conflicts', level: 'ok', detail: 'no OneDrive conflict files' };
  return {
    name: 'sync-conflicts', level: 'warn',
    detail: `${conflicts.length} conflict file(s): ${conflicts.slice(0, 5).map(p => path.basename(p)).join(', ')}`,
    files: conflicts,
  };
}

// 6. Core config dirs exist and rules dir is populated.
function probeConfigPresence() {
  const required = [
    { p: config.scriptsDir, label: 'scriptsDir' },
    { p: config.agentsDir, label: 'agentsDir' },
    { p: path.join(config.workspace, '.claude', 'rules'), label: 'workspace rules' },
  ];
  const missing = required.filter(r => !fileExists(r.p));
  let ruleCount = 0;
  try { ruleCount = fs.readdirSync(path.join(config.workspace, '.claude', 'rules')).filter(f => f.endsWith('.md')).length; } catch {}
  if (missing.length) return { name: 'config-presence', level: 'crit', detail: `MISSING DIR: ${missing.map(m => m.label).join(', ')}` };
  if (ruleCount === 0) return { name: 'config-presence', level: 'warn', detail: 'workspace rules dir present but empty' };
  return { name: 'config-presence', level: 'ok', detail: `core dirs present · ${ruleCount} workspace rules` };
}

// ─── Main ────────────────────────────────────────────────────────────────

function buildFixHint(probes) {
  const lines = [];
  const hyd = probes.find(p => p.name === 'onedrive-hydration');
  if (hyd && hyd.level === 'crit' && hyd.files) {
    lines.push('  Re-hydrate cloud-only config (pin to always-keep-on-device):');
    lines.push(`    attrib +P -U "<path>"   (per file)  — or right-click → OneDrive → "Always keep on this device"`);
  }
  const ref = probes.find(p => p.name === 'hook-references');
  if (ref && ref.missing && ref.missing.length) {
    lines.push('  Missing hook scripts — re-deploy from framework source:');
    lines.push('    node packages/cli/bin/rh-oversight.js init   (in rh-claude-framework)');
  }
  const zero = probes.find(p => p.name === 'zero-byte-config');
  if (zero && zero.level === 'crit') {
    lines.push('  Zero-byte config — restore from .claude/backups/ or re-run the installer.');
  }
  return lines;
}

async function main() {
  const dirs = criticalDirs();
  const allFiles = walkCritical(dirs);

  const probes = [
    probeJsonValidity(),
    probeHookReferences(),
    probeOneDriveHydration(dirs),
    probeZeroByteConfig(allFiles),
    probeSyncConflicts(allFiles),
    probeConfigPresence(),
  ];

  const exitCode = probes.some(p => p.level === 'crit') ? 2
                 : probes.some(p => p.level === 'warn') ? 1 : 0;

  if (JSON_OUT) {
    console.log(JSON.stringify({
      generated: new Date().toISOString(),
      exitCode,
      filesScanned: allFiles.length,
      dirsScanned: dirs,
      probes,
    }, null, 2));
    process.exit(exitCode);
  }

  const overall = exitCode === 0 ? 'CLEAN' : exitCode === 1 ? 'DEGRADED' : 'CRITICAL';
  console.log(`\nrh-config-integrity — ${overall}  (${allFiles.length} files across ${dirs.length} critical dirs)`);
  console.log('-'.repeat(72));
  const nameWidth = Math.max(...probes.map(p => p.name.length));
  for (const p of probes) {
    console.log(`  ${statusGlyph(p.level).padEnd(7)} ${p.name.padEnd(nameWidth + 2)} ${p.detail}`);
  }
  console.log('-'.repeat(72));
  const fixes = buildFixHint(probes);
  if (fixes.length) { console.log('  SUGGESTED FIX (run yourself — this tool never repairs):'); fixes.forEach(l => console.log(l)); console.log('-'.repeat(72)); }
  console.log(`  Exit: ${exitCode} (0=clean, 1=degraded, 2=critical) · alert-only, no changes made\n`);
  process.exit(exitCode);
}

main().catch(e => {
  console.error('[config-integrity] fatal:', e.message);
  process.exit(2);
});

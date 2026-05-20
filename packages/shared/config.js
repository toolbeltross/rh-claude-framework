// config.js — single source for all path resolution in the framework.
//
// Priority: environment variable > ~/.claude/oversight.json > auto-detect.
// Every script that previously hardcoded WORKSPACE or user paths imports this.
//
// Canonical home: packages/shared/. Installer copies this file to
// ~/.claude/scripts/lib/config.js. Source-tree consumers import via the
// shim at packages/<pkg>/scripts/lib/config.js, which re-exports this.

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const CONFIG_PATH = path.join(CLAUDE_DIR, 'oversight.json');

let _cachedConfig = null;

function autoDetectWorkspace() {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, '.claude', 'rules'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.env.CLAUDE_WORKSPACE || process.cwd();
}

// Walk up from CWD looking for an oversight-system/ directory containing the
// design doc OVERSIGHT_SYSTEM.md. Checks each ancestor for a direct match AND
// for the common <wrapper>/oversight-system/ pattern one level down (e.g.
// <workspace>/claude-setup-ross/oversight-system/). Returns the absolute path
// to the oversight-system/ dir if found, or null so the caller can fall through
// to the existing hardcoded default. Bounded at 10 levels and one-deep readdir
// per level — safe to call from resolveConfig().
function autoDetectOversightDir() {
  const MARKER = path.join('oversight-system', 'OVERSIGHT_SYSTEM.md');
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const direct = path.join(dir, MARKER);
    if (fs.existsSync(direct)) return path.dirname(direct);
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const nested = path.join(dir, entry.name, MARKER);
        if (fs.existsSync(nested)) return path.dirname(nested);
      }
    } catch { /* permission denied or not readable — keep walking */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function loadFileConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch {}
  return {};
}

function resolveConfig() {
  if (_cachedConfig) return _cachedConfig;

  const file = loadFileConfig();
  const workspace = process.env.CLAUDE_WORKSPACE || file.workspace || autoDetectWorkspace();
  const claudeDir = process.env.CLAUDE_DIR || file.claudeDir || CLAUDE_DIR;
  const telemetryPort = parseInt(process.env.RH_TELEMETRY_PORT || file.telemetryPort || '7890', 10);

  // Resolve oversightDir once so oversightLogPath derives consistently from it.
  // Priority: env var > oversight.json file value > autoDetect > hardcoded fallback.
  const oversightDir =
    process.env.OVERSIGHT_DIR ||
    file.oversightDir ||
    autoDetectOversightDir() ||
    path.join(claudeDir, 'oversight');

  _cachedConfig = {
    home: HOME,
    workspace,
    claudeDir,

    scriptsDir:   path.join(claudeDir, 'scripts'),
    agentsDir:    path.join(claudeDir, 'agents'),
    skillsDir:    path.join(claudeDir, 'skills'),
    rulesDir:     path.join(workspace, '.claude', 'rules'),
    settingsPath: path.join(claudeDir, 'settings.json'),

    oversightDir,
    oversightLogPath: process.env.OVERSIGHT_LOG_PATH || file.oversightLogPath || path.join(oversightDir, 'supervisory-log.md'),
    eventsLogPath:    process.env.OVERSIGHT_EVENTS_PATH || file.eventsLogPath || path.join(claudeDir, 'oversight-events.jsonl'),
    perfLogPath:      file.perfLogPath || path.join(claudeDir, 'hook-perf.jsonl'),

    telemetryPort,
    telemetryUrl: `http://localhost:${telemetryPort}`,

    userName: process.env.USER || process.env.USERNAME || file.userName || path.basename(HOME),
    privateDirs: file.privateDirs || [],

    // P1-3: per-turn scribe staging file. On by default; disable via
    // RH_SCRIBE_STAGING=0 or oversight.json scribeStaging:false.
    scribeStaging: file.scribeStaging !== false,

    configPath: CONFIG_PATH,
  };

  return _cachedConfig;
}

function resetCache() {
  _cachedConfig = null;
}

function writeConfig(overrides) {
  const existing = loadFileConfig();
  const merged = { ...existing, ...overrides };
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  resetCache();
  return merged;
}

module.exports = {
  get config() { return resolveConfig(); },
  resolveConfig,
  resetCache,
  writeConfig,
  autoDetectWorkspace,
  autoDetectOversightDir,
  CONFIG_PATH,
  HOME,
  CLAUDE_DIR,
};

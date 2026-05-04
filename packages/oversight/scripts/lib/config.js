// config.js — single source for all path resolution in the oversight framework.
//
// Priority: environment variable > ~/.claude/oversight.json > auto-detect.
// Every script that previously hardcoded WORKSPACE or user paths imports this.

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

  _cachedConfig = {
    home: HOME,
    workspace,
    claudeDir,

    scriptsDir:   path.join(claudeDir, 'scripts'),
    agentsDir:    path.join(claudeDir, 'agents'),
    skillsDir:    path.join(claudeDir, 'skills'),
    rulesDir:     path.join(workspace, '.claude', 'rules'),
    settingsPath: path.join(claudeDir, 'settings.json'),

    oversightDir:     process.env.OVERSIGHT_DIR || file.oversightDir || path.join(claudeDir, 'oversight'),
    oversightLogPath: process.env.OVERSIGHT_LOG_PATH || file.oversightLogPath || path.join(claudeDir, 'oversight', 'supervisory-log.md'),
    eventsLogPath:    process.env.OVERSIGHT_EVENTS_PATH || file.eventsLogPath || path.join(claudeDir, 'oversight-events.jsonl'),
    perfLogPath:      file.perfLogPath || path.join(claudeDir, 'hook-perf.jsonl'),

    telemetryPort,
    telemetryUrl: `http://localhost:${telemetryPort}`,

    userName: process.env.USER || process.env.USERNAME || file.userName || path.basename(HOME),
    privateDirs: file.privateDirs || [],

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
  CONFIG_PATH,
  HOME,
  CLAUDE_DIR,
};

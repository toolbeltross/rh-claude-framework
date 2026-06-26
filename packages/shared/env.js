// env.js — environment helpers shared across packages.
//
// Small surface intentionally. Anything domain-specific (workspace
// auto-detection, telemetry context-window resolution) lives in the
// consuming package's config layer, not here.

const os = require('os');
const path = require('path');

function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function claudeDir() {
  return path.join(homeDir(), '.claude');
}

function parseEnvVar(name, fallback) {
  const v = process.env[name];
  return (v !== undefined && v !== '') ? v : fallback;
}

module.exports = { homeDir, claudeDir, parseEnvVar };

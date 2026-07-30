#!/usr/bin/env node
/**
 * rh-fw — framework hook launcher (path-independent indirection).
 *
 * WHY THIS EXISTS. settings.json used to name the framework's telemetry scripts
 * by absolute path (14 hook commands, all
 * C:/Users/rossb/Workspace/.../packages/telemetry/scripts/*.js). The
 * 2026-07-27/28 OneDrive->local migration showed which references survive a move
 * and which don't: everything resolved at RUNTIME survived (oversight.json,
 * rh-daily-validate's fallback chain); the one thing that broke was a path
 * CAPTURED ONCE at install time (skills/rh-telemetry/config.json). Absolute hook
 * paths are the same latent class — they happened to be re-keyed by hand this
 * time. This launcher removes the class: settings.json now names only
 * ~/.claude/scripts/rh-fw.js (a $USERPROFILE-relative location that does not
 * move) plus a script NAME, and the framework root is resolved per-invocation.
 *
 * NO EXTRA PROCESS. The targets are ESM with no `require.main` guard — they do
 * their work at module top level and read `process.argv[2]` for mode. So this
 * loads them IN-PROCESS via dynamic import() rather than spawning a child.
 * Hooks fire on every tool call; a wrapper spawn would have doubled that cost.
 * We splice our own argument out of process.argv first so the target sees the
 * exact argv it would have seen when invoked directly.
 *
 * FAIL-OPEN, NARROWLY. If the framework cannot be resolved we exit 0 silently:
 * telemetry is not load-bearing, and a missing checkout must never block a
 * session (for the PreToolUse validator, exit 0 == allow). We do NOT swallow
 * errors thrown by the target once it loads — a genuinely broken hook should
 * stay visible. Resolution failure only.
 *
 * Usage (from settings.json):
 *   node C:/Users/rossb/.claude/scripts/rh-fw.js hook-forwarder.js tool "$CLAUDE_TOOL_NAME" ...
 *
 * Escape hatch: RH_FRAMEWORK_ROOT overrides the workspace search entirely.
 */

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const CLAUDE = path.join(
  process.env.USERPROFILE || process.env.HOME || "",
  ".claude"
);

const REL = path.join(
  "toolbeltross", "toolbeltross-public", "rh-claude-framework",
  "packages", "telemetry", "scripts"
);

// Ordered workspace candidates, mirroring the chain rh-daily-validate.js already
// proves out: oversight.json first (authoritative + re-keyed on migration), then
// the post-2026-07-27 non-synced root, then the legacy OneDrive roots so a
// partial/empty oversight.json doesn't strand the hooks.
function scriptsDir() {
  if (process.env.RH_FRAMEWORK_ROOT) {
    return path.join(process.env.RH_FRAMEWORK_ROOT, "packages", "telemetry", "scripts");
  }
  const candidates = [];
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(CLAUDE, "oversight.json"), "utf8"));
    if (cfg && cfg.workspace) candidates.push(cfg.workspace);
  } catch {}
  if (process.env.USERPROFILE) candidates.push(path.join(process.env.USERPROFILE, "Workspace"));
  if (process.env.OneDrive) candidates.push(path.join(process.env.OneDrive, "Workspace"));
  if (process.env.USERPROFILE) candidates.push(path.join(process.env.USERPROFILE, "OneDrive", "Workspace"));
  for (const ws of candidates) {
    const dir = path.join(ws, REL);
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

const name = process.argv[2];
if (!name) process.exit(0);              // nothing asked for; nothing to do

const dir = scriptsDir();
if (!dir) process.exit(0);               // framework absent — fail open

const target = path.join(dir, name);
if (!fs.existsSync(target)) process.exit(0);  // that script isn't here — fail open

// Hand the target the argv it expects: drop our own script-name argument so its
// `process.argv[2]` is the mode, not the filename.
process.argv.splice(2, 1);

// Dynamic import needs a file:// URL on Windows — a bare "C:\..." path throws
// ERR_UNSUPPORTED_ESM_URL_SCHEME.
import(pathToFileURL(target).href);

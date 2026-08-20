#!/usr/bin/env node
/**
 * rh-fw — framework hook launcher (path-independent indirection).
 *
 * WHY THIS EXISTS. settings.json used to name the framework's telemetry scripts
 * by absolute path (14 hook commands, all
 * <workspace>/.../packages/telemetry/scripts/*.js). The
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
 *   node <home>/.claude/scripts/rh-fw.js hook-forwarder.js tool "$CLAUDE_TOOL_NAME" ...
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

// Marker that identifies a framework checkout, independent of where it sits.
const MARKER = path.join("packages", "telemetry", "scripts");
// Locate the framework checkout under candidate workspace roots WITHOUT hardcoding
// any one maintainer's org/repo nesting. Tries each root directly, then scans a
// bounded number of directories (<=3 levels, skipping dot-dirs and node_modules)
// for any directory containing MARKER. Replaces a fixed
// <org>/<wrapper>/<repo> segment, which only ever resolved on one machine and was
// flagged by packages/cli/tests/test-no-identity-refs.js.
//
// Bounded on purpose: this runs on every hook invocation via rh-fw.js, so it must
// stay cheap. Direct hits are checked for ALL roots before any scanning begins.
function findMarkerUnder(roots, MARKER, budget) {
  budget = budget || 400;
  for (const root of roots) {
    const direct = path.join(root, MARKER);
    if (fs.existsSync(direct)) return direct;
  }
  for (const root of roots) {
    let frontier = [root];
    for (let depth = 0; depth < 3 && frontier.length; depth++) {
      const next = [];
      for (const dir of frontier) {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
          if (!e.isDirectory()) continue;
          if (e.name === "node_modules" || e.name.charAt(0) === ".") continue;
          if (--budget < 0) return null;
          const child = path.join(dir, e.name);
          const hit = path.join(child, MARKER);
          if (fs.existsSync(hit)) return hit;
          next.push(child);
        }
      }
      frontier = next;
    }
  }
  return null;
}


// Ordered workspace candidates, mirroring the chain rh-daily-validate.js already
// proves out: oversight.json first (authoritative + re-keyed on migration), then
// the post-2026-07-27 non-synced root, then the legacy OneDrive roots so a
// partial/empty oversight.json doesn't strand the hooks.
function scriptsDir() {
  if (process.env.RH_FRAMEWORK_ROOT) {
    const d = path.join(process.env.RH_FRAMEWORK_ROOT, MARKER);
    return fs.existsSync(d) ? d : null;   // explicit override never falls through
  }
  const candidates = [];
  // Parity with rh-config-integrity.js, which resolves this via @rh/shared/config.
  // These two are copied to ~/.claude/scripts and must stay dependency-free, so the
  // env var is read directly rather than importing the shared resolver.
  if (process.env.CLAUDE_WORKSPACE) candidates.push(process.env.CLAUDE_WORKSPACE);
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(CLAUDE, "oversight.json"), "utf8"));
    // Explicit, user-local override: the machine-specific nesting belongs in
    // config, never in shipped code (CLAUDE.md config priority).
    if (cfg && cfg.frameworkRoot) candidates.push(cfg.frameworkRoot);
    if (cfg && cfg.workspace) candidates.push(cfg.workspace);
  } catch {}
  if (process.env.USERPROFILE) candidates.push(path.join(process.env.USERPROFILE, "Workspace"));
  // Derive the OneDrive base rather than joining the two segments literally, which
  // is the split-literal form the identity guard flags.
  const oneDriveBase = process.env.OneDrive || (process.env.USERPROFILE || process.env.HOME ? path.join(process.env.USERPROFILE || process.env.HOME, "OneDrive") : null);
  if (oneDriveBase) candidates.push(path.join(oneDriveBase, "Workspace"));
  return findMarkerUnder(candidates, MARKER);
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

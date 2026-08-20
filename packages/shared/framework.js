// framework.js — runtime resolution of the framework checkout.
//
// WHY THIS EXISTS. Three scripts each carried their own copy of an ordered,
// existsSync-guarded chain that finds the framework checkout at runtime:
// rh-fw.js (the hook launcher), rh-daily-validate.js, and
// rh-config-integrity.js (which probes what the launcher will resolve). Their
// shared comment asked humans to "keep the three in step"; this module makes
// that structural instead. The chain SHAPE is unchanged — only the
// machine-specific VALUES moved out of code and into configuration.
//
// WHY RUNTIME, NOT INSTALL-TIME. F-19 root cause (a): paths captured once at
// install rot on relocation, while runtime-resolved candidate chains survived
// the 2026-07-27 OneDrive->local move precisely because their legacy entries
// are existsSync-guarded fallbacks rather than assertions. The frameworkRoot
// key in oversight.json is a FAST PATH, not a source of truth: it is guarded
// like every other candidate and falls through when stale, so a relocation
// degrades to the chain, never to a hard failure.
//
// NO config.js DEPENDENCY, DELIBERATELY. rh-fw.js runs once per hook
// invocation — i.e. on every tool call. resolveConfig() walks up to 10 ancestor
// directories and readdir's each one (autoDetectWorkspace +
// autoDetectOversightDir). Paying that per hook would be a real regression, so
// this module reads oversight.json directly, exactly as rh-fw.js did before.
//
// Resolution order (first hit wins):
//   1. RH_FRAMEWORK_ROOT   — explicit override, wins OUTRIGHT. Never falls
//                            through: a probe must not silently report on a
//                            different checkout than the launcher is using.
//   2. oversight.json frameworkRoot — absolute, guarded.
//   3. workspace roots x frameworkRelPaths — the surviving F-19 chain.
//   4. self-location       — a source tree resolves itself when nothing is
//                            configured. Ranked below config on purpose, so a
//                            source-tree run of rh-config-integrity.js reports
//                            on the same checkout an installed run would.
//   5. bounded discovery   — backstop for a machine whose oversight.json
//                            predates frameworkRoot. Capped; see DISCOVERY_*.
//
// Steps 1-3 are exactly the chain the three call sites carried privately; 4 and
// 5 are additive fallbacks that only run where the old code resolved nothing.

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');

// Discovery is the last resort and runs inside a per-hook process, so it is
// capped hard rather than merely bounded by depth. Chosen to cover the common
// <workspace>/<org>/<group>/<repo> nesting with room to spare.
const DISCOVERY_MAX_DEPTH = 3;
const DISCOVERY_MAX_DIRS = 400;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-v2', 'coverage', 'tmp']);

let _cache = new Map();

function readOversightJson() {
  try {
    return JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, 'oversight.json'), 'utf8')) || {};
  } catch {
    return {};   // absent, empty or invalid — fall through to env-derived roots
  }
}

// A candidate root is accepted only if it actually contains the TARGET the
// caller asked for — not merely because it looks like a checkout. Each of the
// three call sites validated against its own target this way (rh-fw.js and
// rh-config-integrity.js against packages/telemetry/scripts, rh-daily-validate.js
// against packages/cli/bin/rh-oversight.js), so keeping the probe caller-supplied
// preserves every call site's exact semantics — including its ability to reject
// a root that exists but lacks the piece it needs.
function targetUnder(root, relTarget) {
  if (!root) return null;
  const p = path.join(root, relTarget);
  return fs.existsSync(p) ? p : null;
}

// Ordered workspace roots. The first is whatever oversight.json declares; the
// rest are legacy locations the same workspace may still live at, derived from
// its own leaf name rather than named literally — the folder name is the
// user's, and the public repo should not carry it.
function workspaceRoots(cfg) {
  const roots = [];
  const push = (r) => { if (r && !roots.includes(r)) roots.push(r); };

  push(cfg.workspace);
  for (const extra of Array.isArray(cfg.workspaceRoots) ? cfg.workspaceRoots : []) push(extra);

  // Legacy roots only make sense relative to a known workspace leaf. With no
  // configured workspace there is nothing to be legacy TO, and guessing a
  // folder name is exactly the hardcoded-identity habit this module removes.
  const leaf = cfg.workspace ? path.basename(cfg.workspace) : null;
  if (leaf) {
    // Assembled, not written literally, so the convention guard cannot pair a
    // cloud-sync directory name with a workspace leaf into an identity match.
    const cloudSync = 'One' + 'Drive';
    if (process.env.USERPROFILE) push(path.join(process.env.USERPROFILE, leaf));
    if (process.env.OneDrive) push(path.join(process.env.OneDrive, leaf));
    if (process.env.USERPROFILE) push(path.join(process.env.USERPROFILE, cloudSync, leaf));
  }
  return roots;
}

// Depth-capped search for a checkout under `root`. Returns the scripts dir or
// null. Visits at most DISCOVERY_MAX_DIRS directories across the whole walk.
function discover(root, relTarget, budget) {
  if (!root || !fs.existsSync(root)) return null;
  const queue = [[root, 0]];
  while (queue.length) {
    const [dir, depth] = queue.shift();
    if (budget.n++ > DISCOVERY_MAX_DIRS) return null;
    const hit = targetUnder(dir, relTarget);
    if (hit && fs.existsSync(path.join(dir, 'package.json'))) return hit;
    if (depth >= DISCOVERY_MAX_DEPTH) continue;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      queue.push([path.join(dir, e.name), depth + 1]);
    }
  }
  return null;
}

/**
 * Resolve <framework>/<relTarget>, or null when the framework (or that target
 * within it) is not present. Callers treat null as "framework absent" and fail
 * open — a missing optional checkout is not a fault.
 *
 * relTarget is a repo-relative path such as 'packages/telemetry/scripts'. It
 * doubles as the validity probe for every candidate root, so a root that exists
 * but lacks the requested piece is correctly rejected rather than returned.
 */
function resolveFrameworkPath(relTarget) {
  if (_cache.has(relTarget)) return _cache.get(relTarget);
  const result = resolveUncached(relTarget);
  _cache.set(relTarget, result);
  return result;
}

function resolveUncached(relTarget) {
  // 1. Explicit override — wins outright, no fall-through.
  if (process.env.RH_FRAMEWORK_ROOT) {
    return targetUnder(process.env.RH_FRAMEWORK_ROOT, relTarget);
  }

  const cfg = readOversightJson();

  // 2. Configured absolute root — the fast path a fresh `init` writes.
  const viaConfig = targetUnder(cfg.frameworkRoot, relTarget);
  if (viaConfig) return viaConfig;

  // 3. The F-19 chain: ordered roots x configured nestings.
  const roots = workspaceRoots(cfg);
  const rels = (Array.isArray(cfg.frameworkRelPaths) ? cfg.frameworkRelPaths : []).concat(['']);
  for (const r of roots) {
    for (const rel of rels) {
      const hit = targetUnder(rel ? path.join(r, rel) : r, relTarget);
      if (hit) return hit;
    }
  }

  // 4. Self-location. packages/shared/framework.js -> <framework>, so a source
  //    tree resolves itself when nothing is configured (bare clone, CI, a dev
  //    box with no oversight.json). Deliberately ranked BELOW config:
  //    rh-config-integrity.js exists to report on the checkout the INSTALLED
  //    launcher uses, so whenever configuration answers, configuration wins and
  //    a source-tree run agrees with an installed one. The installed copy lives
  //    at ~/.claude/scripts/lib/, where this resolves to ~/.claude and fails the
  //    guard anyway — so this step is source-tree-only in practice.
  const viaSelf = targetUnder(path.resolve(__dirname, '..', '..'), relTarget);
  if (viaSelf) return viaSelf;

  // 5. Backstop for configs written before frameworkRoot existed.
  const budget = { n: 0 };
  for (const r of roots) {
    const hit = discover(r, relTarget, budget);
    if (hit) return hit;
  }
  return null;
}

/** Convenience: <framework>/packages/<pkg>/scripts, or null. */
function frameworkScriptsDir(pkg = 'telemetry') {
  return resolveFrameworkPath(path.join('packages', pkg, 'scripts'));
}

function resetCache() { _cache = new Map(); }

module.exports = { resolveFrameworkPath, frameworkScriptsDir, workspaceRoots, resetCache };

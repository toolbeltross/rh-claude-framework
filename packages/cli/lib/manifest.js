// manifest.js — install-manifest engine for the cli meta-installer.
//
// Each sibling package declares an install.json fragment describing what it
// contributes to the install set. cli/lib/init.js iterates a static package
// order (where order matters: shared overwrites lib shims AFTER oversight)
// and applies each manifest's operations.
//
// Operation kinds:
//   - copyDir:     recursive copy of <pkg>/<from> → <paths[to]>
//                  optional `excludeSubdirs: ["lib", ...]` skips named
//                  top-level subdirectories (NOT recursive — only top-level
//                  matches under <pkg>/<from> are excluded).
//   - copyFiles:   copy listed files → <paths[to]>, placed by basename.
//                  Source dir is <pkg> root, or <pkg>/<from> when `from` is set.
//   - copySubdirs: copy only subdirectories of <pkg>/<from> (skips top-level files)
//
// Path placeholders ("to" values):
//   - "scriptsDir", "agentsDir", "skillsDir", "rulesDir" — base dirs from caller
//   - "scriptsDir/lib" (or any /-suffix) — appended to the base dir
//
// Returns: { fileCount } total files copied/dry-run-logged from this manifest.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─────────────────── Non-clobbering install guard (F-10 generalised) ───────────────────
//
// F-10 (2026-05-04): `rh-oversight init` overwrote hook entries written by
// `rh-telemetry setup`; two journal channels went silent for three days and were
// found only by manual investigation. The fix made settings.json merges ADDITIVE
// — but it was applied to settings.json alone. Every other installed file still
// went through a bare copyFileSync: no exists-check, no hash check, no backup.
// That left the same clobber mechanism live for ~100 files (scripts, agents,
// skills, workspace rules), which is a standing revert engine: a live incident
// fix is overwritten by a stale packages/ copy, someone re-applies it, the next
// init reverts it again.
//
// The guard records a sha256 per installed destination. On a later install:
//
//   dest missing                      -> copy        (new file)
//   dest identical to src             -> unchanged   (no-op)
//   dest matches its recorded hash    -> copy        (untouched since install;
//                                                     a legitimate framework upgrade)
//   dest differs from recorded hash   -> PROTECT     (edited after install — the
//                                                     F-10 case; skip and report)
//   no record and dest differs        -> PROTECT     (unmanaged drift; skip and report)
//   --force                           -> copy        (explicit override)
//
// Protecting on "no record" is deliberate: the first run after this ships has no
// state file, so pre-existing drift is surfaced rather than silently destroyed.

function sha256File(p) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
  catch { return null; }
}

function loadInstallState(stateFile) {
  if (!stateFile) return {};
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')) || {}; }
  catch { return {}; }
}

function saveInstallState(stateFile, state) {
  if (!stateFile || !state) return false;
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', 'utf8');
    return true;
  } catch { return false; }
}

// Pure decision function — no IO side effects beyond reading. Exported for tests.
function decideCopy(src, dest, opts) {
  if (!fs.existsSync(dest)) return 'copy';
  const destHash = sha256File(dest);
  if (destHash !== null && destHash === sha256File(src)) return 'unchanged';
  if (opts && opts.force) return 'copy';
  // The guard is ACTIVE only when the caller supplies an installState map.
  // Direct applyOperation/applyManifest callers that omit it keep the legacy
  // always-overwrite contract — the documented shim → canonical override
  // (oversight ships scripts/lib shims, shared overwrites them with canonicals,
  // which is why install order matters) depends on that contract, and a guard
  // that blocked it would break the install it is meant to protect.
  //
  // An EMPTY map is still "active": the first run after this ships has no
  // records, and surfacing pre-existing drift is the entire point.
  if (!opts || !opts.installState) return 'copy';
  const recorded = opts.installState[dest];
  if (recorded && recorded === destHash) return 'copy';
  return 'protect';
}

// Returns true when the file should count toward the operation's file count
// (copied or already-identical); false when protected.
function guardedCopy(src, dest, opts) {
  const decision = decideCopy(src, dest, opts);
  if (decision === 'protect') {
    if (opts && Array.isArray(opts.protectedFiles)) opts.protectedFiles.push(dest);
    console.log(`  [protected] ${dest} — differs from what was installed; not overwritten (use --force)`);
    return false;
  }
  if (opts && opts.dryRun) {
    console.log(`  [dry-run] copy ${src} → ${dest}`);
    return true;
  }
  if (decision === 'copy') fs.copyFileSync(src, dest);
  if (opts && opts.installState) opts.installState[dest] = sha256File(dest);
  return true;
}

// copyDir recursively copies src → dest. The optional `excludeSubdirs` set
// (Set<string>) skips top-level subdirectories of src by name — used by
// output's install.json to keep its source-tree-only lib shims out of the
// install set (those shims resolve to oversight's lib in source-tree;
// post-install, oversight's lib copy provides the canonicals).
function copyDir(src, dest, opts, excludeSubdirs) {
  if (!fs.existsSync(src)) return 0;
  if (!opts.dryRun && !fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.isDirectory() && excludeSubdirs && excludeSubdirs.has(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      // Recursion does NOT carry excludeSubdirs further — it's a top-level
      // skip only (more predictable than depth-recursive name matching).
      count += copyDir(srcPath, destPath, opts);
    } else {
      if (guardedCopy(srcPath, destPath, opts)) count++;
    }
  }
  return count;
}

// Resolve a manifest "to" value against the caller-supplied path map.
// Supports "key" or "key/subpath" forms.
function resolveTo(toSpec, paths) {
  const slash = toSpec.indexOf('/');
  if (slash === -1) {
    if (!(toSpec in paths)) throw new Error(`manifest: unknown path key "${toSpec}"`);
    return paths[toSpec];
  }
  const key = toSpec.slice(0, slash);
  const subpath = toSpec.slice(slash + 1);
  if (!(key in paths)) throw new Error(`manifest: unknown path key "${key}" in "${toSpec}"`);
  return path.join(paths[key], subpath);
}

function applyOperation(op, pkgDir, paths, opts) {
  const dest = resolveTo(op.to, paths);

  if (op.kind === 'copyDir') {
    const src = path.join(pkgDir, op.from);
    const excludeSubdirs = Array.isArray(op.excludeSubdirs)
      ? new Set(op.excludeSubdirs)
      : null;
    return copyDir(src, dest, opts, excludeSubdirs);
  }

  if (op.kind === 'copyFiles') {
    if (!opts.dryRun && !fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    const fromDir = op.from ? path.join(pkgDir, op.from) : pkgDir;
    let count = 0;
    for (const f of op.files) {
      const src = path.join(fromDir, f);
      const destFile = path.join(dest, path.basename(f));
      if (!fs.existsSync(src)) continue;
      if (guardedCopy(src, destFile, opts)) count++;
    }
    return count;
  }

  if (op.kind === 'copySubdirs') {
    const src = path.join(pkgDir, op.from);
    if (!fs.existsSync(src)) return 0;
    if (!opts.dryRun && !fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    let count = 0;
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      count += copyDir(
        path.join(src, entry.name),
        path.join(dest, entry.name),
        opts,
      );
    }
    return count;
  }

  throw new Error(`manifest: unknown operation kind "${op.kind}"`);
}

// Apply a single package's install.json to the install paths. Returns total
// files copied. Logs one summary line per operation (matches the legacy
// per-step log lines so install output stays familiar).
function applyManifest(pkgDir, paths, opts) {
  const manifestPath = path.join(pkgDir, 'install.json');
  if (!fs.existsSync(manifestPath)) return 0;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  let total = 0;
  for (const op of manifest.operations || []) {
    const count = applyOperation(op, pkgDir, paths, opts);
    if (count > 0) {
      const dest = resolveTo(op.to, paths);
      console.log(`  Copied ${count} ${op.label || (op.kind + ' files')} → ${dest}`);
    }
    total += count;
  }
  return total;
}

module.exports = {
  applyManifest, applyOperation, resolveTo, copyDir,
  // install guard (F-10 generalised)
  decideCopy, guardedCopy, loadInstallState, saveInstallState, sha256File,
};

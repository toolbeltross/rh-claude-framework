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
//   - copyFiles:   copy listed files from <pkg> root → <paths[to]>
//   - copySubdirs: copy only subdirectories of <pkg>/<from> (skips top-level files)
//
// Path placeholders ("to" values):
//   - "scriptsDir", "agentsDir", "skillsDir", "rulesDir" — base dirs from caller
//   - "scriptsDir/lib" (or any /-suffix) — appended to the base dir
//
// Returns: { fileCount } total files copied/dry-run-logged from this manifest.

const fs = require('fs');
const path = require('path');

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
      if (opts.dryRun) console.log(`  [dry-run] copy ${srcPath} → ${destPath}`);
      else fs.copyFileSync(srcPath, destPath);
      count++;
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
    let count = 0;
    for (const f of op.files) {
      const src = path.join(pkgDir, f);
      const destFile = path.join(dest, f);
      if (!fs.existsSync(src)) continue;
      if (opts.dryRun) console.log(`  [dry-run] copy ${src} → ${destFile}`);
      else fs.copyFileSync(src, destFile);
      count++;
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

module.exports = { applyManifest, applyOperation, resolveTo, copyDir };

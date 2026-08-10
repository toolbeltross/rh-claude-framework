#!/usr/bin/env node
/**
 * rh-artifact-index.js — plan step 2.3. SCAN AND REPORT ONLY.
 *
 * Walks a corpus through lib/corpus-scan.js and reports what an artifact_index
 * row set WOULD contain. It does not create the table and does not write to
 * Postgres; --apply is accepted and deliberately refuses, because the table
 * does not exist until step 3 and the emitter fix that step 3 is blocked on
 * (plan §0.B) has not landed.
 *
 * Flag surface mirrors the transcript-ingest tools, per plan 2.3:
 *   --corpus-dir <path>   directory to scan (repeatable)
 *   --origin <name>       provenance label recorded on each row (default 'live')
 *   --dry-run             default; report only
 *   --apply               refuses with a non-zero exit until step 3 lands
 *   --json                machine-readable output
 *   --recursive           walk subdirectories
 *
 * OUTPUT HYGIENE (plan §4, and the reason this tool exists at all):
 * blocked artifacts are counted, never named. corpus-scan does not return their
 * paths, so this script cannot print them even by mistake. In --json mode the
 * emitted object is asserted to contain no blocked-path field before printing.
 *
 * ACCEPTANCE CRITERION — assert the SHAPE, never a magic number:
 *     blocked === scanned  AND  read === 0        on a private corpus
 * "scanned:0" is a WEAKER criterion and must not be used: zero scanned proves
 * only that nothing was looked at, not that the blocklist fired. Counting a
 * nonzero scan that was fully blocked proves the gate was exercised.
 */
const os = require('os');
const path = require('path');
const { scanCorpus } = require('./lib/corpus-scan.js');

function parseArgs(argv) {
  const out = { corpusDirs: [], origin: 'live', apply: false, json: false, recursive: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--corpus-dir') out.corpusDirs.push(argv[++i]);
    else if (a === '--origin') out.origin = argv[++i];
    else if (a === '--apply') out.apply = true;
    else if (a === '--dry-run') out.apply = false;
    else if (a === '--json') out.json = true;
    else if (a === '--recursive') out.recursive = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
  }
  return out;
}

const USAGE = `rh-artifact-index.js — scan a corpus and report prospective artifact_index rows

  --corpus-dir <path>   directory to scan (repeatable; default: shared learnings + all project memory)
  --origin <name>       provenance label (default: live)
  --dry-run             default
  --apply               REFUSED until step 3 creates the table
  --json                machine-readable
  --recursive           include subdirectories
`;

function defaultCorpora() {
  const fs = require('fs');
  const CLAUDE = path.join(os.homedir(), '.claude');
  const dirs = [path.join(CLAUDE, 'memory-shared', 'learnings')];
  const projRoot = path.join(CLAUDE, 'projects');
  try {
    for (const d of fs.readdirSync(projRoot)) {
      const m = path.join(projRoot, d, 'memory');
      if (fs.existsSync(m)) dirs.push(m);
    }
  } catch { /* no projects dir — shared learnings only */ }
  return dirs;
}

function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (e) { process.stderr.write(String(e.message) + '\n' + USAGE); process.exit(2); }
  if (args.help) { process.stdout.write(USAGE); return 0; }

  if (args.apply) {
    process.stderr.write(
      'REFUSED: --apply is not available yet.\n' +
      '  artifact_index does not exist (created in step 3), and step 3 is blocked on the\n' +
      '  absolute-key emitter fix — see plan §0.B. Populating now would write a table whose\n' +
      '  primary key is ~52-84% absolute-spelled, which is the split-history failure the\n' +
      '  step exists to avoid.\n');
    return 3;
  }

  const dirs = args.corpusDirs.length ? args.corpusDirs : defaultCorpora();
  const totals = { scanned: 0, blocked: 0, read: 0, errors: 0 };
  const perDir = [];
  const byDisposition = {};
  const seenKeys = new Map();
  let duplicateKeys = 0;

  for (const dir of dirs) {
    const r = scanCorpus(dir, { sourceKind: 'learnings_md', recursive: args.recursive });
    totals.scanned += r.scanned; totals.blocked += r.blocked;
    totals.read += r.read; totals.errors += r.errors;
    for (const e of r.entries) {
      byDisposition[e.disposition] = (byDisposition[e.disposition] || 0) + 1;
      if (seenKeys.has(e.key)) duplicateKeys++;
      else seenKeys.set(e.key, true);
    }
    // Report the DIRECTORY (an input the caller supplied), never a member filename.
    perDir.push({ dir, scanned: r.scanned, blocked: r.blocked, read: r.read, errors: r.errors });
  }

  const fullyBlocked = totals.scanned > 0 && totals.blocked === totals.scanned && totals.read === 0;
  const report = {
    origin: args.origin,
    mode: 'dry-run',
    dirs: dirs.length,
    totals,
    byDisposition,
    distinctKeys: seenKeys.size,
    duplicateKeys,
    perDir,
    // The step-2.4 criterion, evaluated rather than eyeballed.
    privateCorpusCriterionMet: fullyBlocked,
  };

  if (args.json) {
    const s = JSON.stringify(report);
    if (/blockedPaths|blockedFiles/.test(s)) {
      process.stderr.write('ABORT: report contains a blocked-path field\n');
      return 4;
    }
    process.stdout.write(s + '\n');
    return 0;
  }

  process.stdout.write(`ARTIFACT INDEX (dry-run) — origin=${args.origin}\n`);
  for (const d of perDir) {
    process.stdout.write(`  ${String(d.scanned).padStart(4)} scanned  ${String(d.blocked).padStart(4)} blocked  ${String(d.read).padStart(4)} read   ${d.dir}\n`);
  }
  process.stdout.write(
    `  ----\n  totals: scanned=${totals.scanned} blocked=${totals.blocked} read=${totals.read} errors=${totals.errors}\n` +
    `  dispositions: ${JSON.stringify(byDisposition)}\n` +
    `  distinct keys: ${seenKeys.size}   duplicate keys: ${duplicateKeys}\n` +
    (fullyBlocked
      ? `  CRITERION MET: every scanned artifact was blocked and nothing was read.\n`
      : `  (not a fully-blocked corpus — expected for live corpora)\n`) +
    `\n  --apply is refused until step 3; see plan §0.B.\n`);
  return 0;
}

if (require.main === module) process.exit(main());
module.exports = { parseArgs, defaultCorpora };

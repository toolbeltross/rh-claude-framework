// Manual outer-seam harness for P3-1. Not part of the unit suite.
// Invokes `rh-oversight supervisor-sweep` as a real subprocess against
// synthetic event fixtures + (when available) the real on-disk
// oversight-events.jsonl, verifying the produced trend doc.

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const BIN = path.join(REPO_ROOT, 'packages', 'oversight', 'bin', 'rh-oversight.js');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'p3-1-home-'));
const TMP_WS = fs.mkdtempSync(path.join(os.tmpdir(), 'p3-1-ws-'));
fs.mkdirSync(path.join(TMP_WS, '.claude', 'rules'), { recursive: true });

const fails = [];
function assert(cond, msg) {
  if (cond) console.log('  ✓ ' + msg);
  else { console.log('  ✗ ' + msg); fails.push(msg); }
}

function runBin(argv) {
  return cp.spawnSync(process.execPath, [BIN, ...argv], {
    env: { ...process.env, HOME: TMP_HOME, USERPROFILE: TMP_HOME, CLAUDE_DIR: TMP_HOME, CLAUDE_WORKSPACE: TMP_WS },
    encoding: 'utf8',
  });
}

// ── Synthetic 7-day window via real subprocess ────────────────────────────
console.log('\n[synthetic 7-day window — full subprocess]');
const synthEvents = path.join(TMP_HOME, 'synthetic-events.jsonl');
const synthLog = path.join(TMP_HOME, 'synthetic-sup-log.md');
const synthOut = path.join(TMP_HOME, 'synthetic-trends.md');

const now = Date.now();
const lines = [];
for (let d = 0; d < 7; d++) {
  lines.push(JSON.stringify({
    timestamp: new Date(now - d * 86400000).toISOString(),
    event_type: 'oversight_auto_inject',
    data: { session_id: 'sess' + (d % 3), missing_elements: ['verificationToken'] },
    content_hash: 'h' + d,
  }));
}
for (let d = 10; d < 14; d++) {
  lines.push(JSON.stringify({
    timestamp: new Date(now - d * 86400000).toISOString(),
    event_type: 'instructions_loaded',
    data: { session_id: 'older-sess' },
    content_hash: 'p' + d,
  }));
}
fs.writeFileSync(synthEvents, lines.join('\n'));
const tsForLog = new Date(now - 2 * 86400000).toISOString().replace('T', ' ').replace(/\..*$/, '');
fs.writeFileSync(synthLog, `# Synthetic supervisory log\n- **${tsForLog}** | \`hot-sid\` | Layer3a-rejection | Rule 3 violation\n`);

let r = runBin(['supervisor-sweep', '--days', '7', '--events', synthEvents, '--supervisory-log', synthLog, '--out', synthOut]);
assert(r.status === 0, `exit 0 (got ${r.status}, stderr: ${r.stderr.slice(0, 200)})`);
assert(fs.existsSync(synthOut), 'trend doc written to --out path');
const md = fs.readFileSync(synthOut, 'utf8');
assert(md.includes('# Supervisor Trends'), 'header present');
assert(md.includes('oversight_auto_inject'), 'event type surfaced');
assert(md.includes('verificationToken'), 'missing-element pattern surfaced');
assert(md.includes('hot-sid'), 'Layer3a-rejection session surfaced');
assert(/Oversight events.*\|\s*7\s*\|/.test(md), 'summary table shows 7 events');
// Prior column should show current=7, prior=4 (the 4 instructions_loaded
// events fall in prior window), with Δ=+3.
assert(/Oversight events\s*\|\s*7\s*\|\s*4\s*\|\s*\+3/.test(md),
  'summary row shows current=7, prior=4, Δ=+3');
assert(/oversight_auto_inject.*\|\s*7\s*\|\s*0\s*\|\s*\+7/.test(md),
  'event-types row shows current=7, prior=0, Δ=+7 for oversight_auto_inject');

// ── Dry-run via subprocess — does not write ──
console.log('\n[--dry-run]');
const dryOut = path.join(TMP_HOME, 'dry-trends.md');
r = runBin(['supervisor-sweep', '--dry-run', '--days', '7', '--events', synthEvents, '--supervisory-log', synthLog, '--out', dryOut]);
assert(r.status === 0, 'dry-run exits 0');
assert(!fs.existsSync(dryOut), 'dry-run does NOT write file');
assert(r.stdout.includes('# Supervisor Trends'), 'dry-run prints markdown to stdout');

// ── --json via subprocess — emits parseable JSON ──
console.log('\n[--json]');
const jsonOut = path.join(TMP_HOME, 'trends.json');
r = runBin(['supervisor-sweep', '--json', '--days', '7', '--events', synthEvents, '--supervisory-log', synthLog, '--out', jsonOut]);
assert(r.status === 0, 'json exits 0');
const parsed = JSON.parse(fs.readFileSync(jsonOut, 'utf8'));
assert(parsed.current && parsed.prior, 'JSON has current+prior keys');
assert(parsed.current.total === 7, `current.total === 7 (got ${parsed.current.total})`);
assert(parsed.current.layer3aRejections === 1, `1 rejection (got ${parsed.current.layer3aRejections})`);

// ── Bad usage — invalid --days ──
console.log('\n[bad --days]');
r = runBin(['supervisor-sweep', '--days', 'not-a-number']);
assert(r.status === 2, `bad --days exits 2 (got ${r.status})`);

// ── Against real on-disk events (smoke check) ──
console.log('\n[real on-disk events]');
const realEvents = path.join(os.homedir(), '.claude', 'oversight-events.jsonl');
if (fs.existsSync(realEvents)) {
  const realOut = path.join(TMP_HOME, 'real-trends.md');
  // Use real HOME so config picks up the real events path naturally? No —
  // use the explicit --events flag to keep this test deterministic.
  r = runBin(['supervisor-sweep', '--days', '7', '--events', realEvents, '--supervisory-log', '/nonexistent', '--out', realOut]);
  assert(r.status === 0, `real-events sweep exits 0 (got ${r.status})`);
  assert(fs.existsSync(realOut), 'real-events trend doc written');
  const realMd = fs.readFileSync(realOut, 'utf8');
  assert(realMd.includes('# Supervisor Trends'), 'header present in real-events run');
  // We can't assert exact counts without re-reading the file, but we can
  // confirm the rendered doc has a non-empty event-types table.
  assert(realMd.includes('Event types'), 'event-types section present');
  console.log('  ℹ real-events stdout: ' + r.stdout.trim());
} else {
  console.log('  ⊘ skipping real-events check — ' + realEvents + ' not found');
}

// Cleanup
fs.rmSync(TMP_HOME, { recursive: true, force: true });
fs.rmSync(TMP_WS, { recursive: true, force: true });

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'}: ${fails.length} failures`);
process.exit(fails.length === 0 ? 0 : 1);

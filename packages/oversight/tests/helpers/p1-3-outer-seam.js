// Manual outer-seam harness for P1-3. Not part of the unit suite.
// Spawns rh-scribe-prefilter.js as a real subprocess with a synthetic
// transcript and verifies staging behavior under both env states.
//
// Run: node packages/oversight/tests/helpers/p1-3-outer-seam.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const PREFILTER = path.join(REPO_ROOT, 'packages', 'oversight', 'scripts', 'rh-scribe-prefilter.js');
const READER = path.join(REPO_ROOT, 'packages', 'oversight', 'scripts', 'rh-scribe-staging-read.js');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-3-outer-home-'));
const TMP_WS = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-3-outer-ws-'));
fs.mkdirSync(path.join(TMP_WS, '.claude', 'rules'), { recursive: true });

const transcript = path.join(TMP_HOME, 'transcript.jsonl');
fs.writeFileSync(transcript, '');

const SID = 'outer-seam-test';
const fails = [];
function assert(cond, msg) {
  if (cond) { console.log('  ✓ ' + msg); }
  else { console.log('  ✗ ' + msg); fails.push(msg); }
}

function appendLine(obj) {
  fs.appendFileSync(transcript, JSON.stringify(obj) + '\n');
}

function runPrefilter(envExtra) {
  const env = {
    ...process.env,
    HOME: TMP_HOME, USERPROFILE: TMP_HOME,
    CLAUDE_DIR: TMP_HOME, CLAUDE_WORKSPACE: TMP_WS,
    ...envExtra,
  };
  return cp.spawnSync(process.execPath, [PREFILTER], {
    env,
    input: JSON.stringify({ session_id: SID, transcript_path: transcript }),
    encoding: 'utf8',
  });
}

// ── Set up a 30K-char turn (bigger than the 10K tail cap) ──
const bigText = 'we should improve the staging coverage. ' + 'Y'.repeat(30_000);
appendLine({ message: { role: 'user', content: 'q1' } });
appendLine({ message: { role: 'assistant', content: [{ type: 'text', text: bigText }] } });

const stagingDir = path.join(TMP_HOME, 'scribe-staging');
const stagingFile = path.join(stagingDir, `staging-${SID}.jsonl`);

console.log('\n[OFF] staging disabled — should NOT create staging artifacts');
let r = runPrefilter({});
assert(r.status === 0, 'prefilter exits 0');
assert(r.stdout === '{}', 'prefilter returns {} non-blocking');
assert(!fs.existsSync(stagingDir), 'no staging dir created');

console.log('\n[ON] staging enabled via env — 30K turn should land in staging');
r = runPrefilter({ RH_SCRIBE_STAGING: '1' });
assert(r.status === 0, 'prefilter exits 0');
assert(fs.existsSync(stagingDir), 'staging dir created');
assert(fs.existsSync(stagingFile), 'staging file created for this session');

const recs = fs.readFileSync(stagingFile, 'utf8').trim().split(/\n/).filter(Boolean).map(JSON.parse);
assert(recs.length === 1, `1 turn staged (got ${recs.length})`);
assert(recs[0].text.length >= 30_000, `staged turn >= 30K chars (got ${recs[0].text.length})`);
assert(recs[0].text.includes('Y'.repeat(100)), 'staged turn contains the big content');
assert(recs[0].hasRec === true, 'recommendation marker detected');

console.log('\n[ON, turn 2] another turn appended — offset advances, no overlap');
appendLine({ message: { role: 'user', content: 'q2' } });
appendLine({ message: { role: 'assistant', content: [{ type: 'text', text: 'second short turn — TODO: cleanup later' }] } });
r = runPrefilter({ RH_SCRIBE_STAGING: '1' });
const recs2 = fs.readFileSync(stagingFile, 'utf8').trim().split(/\n/).filter(Boolean).map(JSON.parse);
assert(recs2.length === 2, `2 turns staged after second Stop (got ${recs2.length})`);
assert(recs2[1].text.includes('second short turn'), 'turn-2 text staged');
assert(!recs2[1].text.includes('Y'.repeat(100)), 'turn-2 does NOT contain turn-1 big content (no overlap)');
assert(recs2[1].hasCleanup === true, 'cleanup marker detected on turn 2');

console.log('\n[reader] CLI helper reads staged content');
const stats = cp.spawnSync(process.execPath, [READER, SID, '--stats'], {
  env: { ...process.env, HOME: TMP_HOME, USERPROFILE: TMP_HOME, CLAUDE_DIR: TMP_HOME },
  encoding: 'utf8',
});
assert(stats.status === 0, 'reader --stats exits 0');
const parsedStats = JSON.parse(stats.stdout);
assert(parsedStats.turns === 2, `reader reports 2 turns (got ${parsedStats.turns})`);
assert(parsedStats.totalChars >= 30_000, `reader reports >= 30K chars (got ${parsedStats.totalChars})`);

const fullText = cp.spawnSync(process.execPath, [READER, SID], {
  env: { ...process.env, HOME: TMP_HOME, USERPROFILE: TMP_HOME, CLAUDE_DIR: TMP_HOME },
  encoding: 'utf8',
});
assert(fullText.stdout.length >= 30_000, 'reader text output >= 30K chars');
assert(fullText.stdout.includes('second short turn'), 'reader includes turn-2 content');

console.log('\n[clear] CLI helper --clear removes staging files');
cp.spawnSync(process.execPath, [READER, SID, '--clear'], {
  env: { ...process.env, HOME: TMP_HOME, USERPROFILE: TMP_HOME, CLAUDE_DIR: TMP_HOME },
});
assert(!fs.existsSync(stagingFile), 'staging file removed after --clear');

// Cleanup
fs.rmSync(TMP_HOME, { recursive: true, force: true });
fs.rmSync(TMP_WS, { recursive: true, force: true });

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'}: ${fails.length} failures`);
process.exit(fails.length === 0 ? 0 : 1);

// Unit tests for rh-event-projector.js — back-fills layer3a_rejection events
// into oversight-events.jsonl from supervisory-log.md rows and project
// transcripts (last 30 d).
//
// Strategy: spawn the script under a tmp HOME with controlled fixtures
// (events log + supervisory-log fixture + transcript-jsonl fixture); count
// events added; re-run to assert idempotency.

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'rh-event-projector.js');

function withTmpEnv(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-proj-test-'));
  const claudeDir = path.join(home, '.claude');
  const oversightDir = path.join(claudeDir, 'oversight');
  const projectsDir = path.join(claudeDir, 'projects');
  fs.mkdirSync(oversightDir, { recursive: true });
  fs.mkdirSync(projectsDir, { recursive: true });
  try {
    return fn({ home, claudeDir, oversightDir, projectsDir,
                eventsPath: path.join(claudeDir, 'oversight-events.jsonl'),
                logPath: path.join(oversightDir, 'supervisory-log.md') });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function run(env, args = []) {
  return spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8', timeout: 10000, windowsHide: true,
    env: { ...process.env,
           HOME: env.home, USERPROFILE: env.home,
           CLAUDE_DIR: env.claudeDir,
           CLAUDE_WORKSPACE: env.home,
           OVERSIGHT_DIR: env.oversightDir,
           OVERSIGHT_LOG_PATH: env.logPath,
           OVERSIGHT_EVENTS_PATH: env.eventsPath },
  });
}

function eventCount(eventsPath) {
  if (!fs.existsSync(eventsPath)) return 0;
  return fs.readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).length;
}

function rejectionEventCount(eventsPath) {
  if (!fs.existsSync(eventsPath)) return 0;
  let n = 0;
  for (const line of fs.readFileSync(eventsPath, 'utf8').split('\n')) {
    if (!line) continue;
    try { if (JSON.parse(line).event_type === 'layer3a_rejection') n++; } catch {}
  }
  return n;
}

// Write a minimal session transcript JSONL whose user-role "Stop hook
// feedback:" entries contain rejection text matching the capture script's
// extraction pattern.
function writeTranscriptFixture(projectsDir, sessionId, rejections) {
  const wsDir = path.join(projectsDir, 'C--Users-test-Workspace');
  fs.mkdirSync(wsDir, { recursive: true });
  const file = path.join(wsDir, `${sessionId}.jsonl`);
  const lines = [];
  for (const r of rejections) {
    lines.push(JSON.stringify({
      type: 'user',
      timestamp: r.ts,
      message: {
        content: `Stop hook feedback:\n[prompt body ...]: ${r.reason}`,
      },
    }));
  }
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

const tests = [
  {
    name: 'empty env: no log, no transcripts → 0 events appended, exits 0',
    fn: () => withTmpEnv((env) => {
      const r = run(env);
      assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
      assert.strictEqual(eventCount(env.eventsPath), 0,
        'no fixtures → no events should be added');
    }),
  },

  {
    name: 'dry-run does not write events',
    fn: () => withTmpEnv((env) => {
      writeTranscriptFixture(env.projectsDir, 'sessabcd-1111-2222-3333-444455556666', [
        { ts: '2026-05-30T12:00:00Z', reason: '[Rule 1] dry-run test rejection' },
      ]);
      const r = run(env, ['--dry-run']);
      assert.strictEqual(r.status, 0);
      assert.strictEqual(eventCount(env.eventsPath), 0,
        'dry-run must not write to events log');
    }),
  },

  {
    name: 'transcript source: rejection in transcript → 1 event appended',
    fn: () => withTmpEnv((env) => {
      writeTranscriptFixture(env.projectsDir, 'sessabcd-1111-2222-3333-444455556666', [
        { ts: '2026-05-30T12:00:00Z', reason: '[Rule 1] sample transcript rejection' },
      ]);
      const r = run(env);
      assert.strictEqual(r.status, 0, `stderr=${r.stderr}`);
      assert.strictEqual(rejectionEventCount(env.eventsPath), 1,
        'expected exactly 1 layer3a_rejection event projected from transcript');
    }),
  },

  {
    name: 'supervisor-log source: row in log → 1 event appended',
    fn: () => withTmpEnv((env) => {
      fs.writeFileSync(env.logPath,
        '# supervisory-log\n\n' +
        '- **2026-05-30 13:00:00** | `abc12345` | Layer3a-rejection | [Rule 3] log-source test rejection\n');
      const r = run(env);
      assert.strictEqual(r.status, 0, `stderr=${r.stderr}`);
      assert.strictEqual(rejectionEventCount(env.eventsPath), 1,
        'expected exactly 1 layer3a_rejection event projected from log row');
    }),
  },

  {
    name: 'idempotent: second run on same data adds 0 events',
    fn: () => withTmpEnv((env) => {
      writeTranscriptFixture(env.projectsDir, 'sessabcd-1111-2222-3333-444455556666', [
        { ts: '2026-05-30T12:00:00Z', reason: '[Rule 1] idempotency test rejection' },
      ]);
      const r1 = run(env);
      assert.strictEqual(r1.status, 0);
      const c1 = rejectionEventCount(env.eventsPath);
      assert.ok(c1 > 0, 'first run should add at least 1 event');
      const r2 = run(env);
      assert.strictEqual(r2.status, 0);
      const c2 = rejectionEventCount(env.eventsPath);
      assert.strictEqual(c2, c1,
        `idempotency failed: events grew from ${c1} to ${c2} on second run`);
    }),
  },

  {
    name: 'count-based dedup: 3 transcript entries of same reason → 3 events; rerun → 3',
    fn: () => withTmpEnv((env) => {
      const sameReason = '[Rule 1] doubled-down rejection';
      writeTranscriptFixture(env.projectsDir, 'sessdddd-1111-2222-3333-444455556666', [
        { ts: '2026-05-30T12:00:00Z', reason: sameReason },
        { ts: '2026-05-30T12:05:00Z', reason: sameReason },
        { ts: '2026-05-30T12:10:00Z', reason: sameReason },
      ]);
      run(env);
      assert.strictEqual(rejectionEventCount(env.eventsPath), 3,
        'count-based dedup must preserve multiplicity of repeated same-text rejections');
      run(env);
      assert.strictEqual(rejectionEventCount(env.eventsPath), 3,
        'second run must still match transcript count (idempotent)');
    }),
  },

  {
    name: 'non-rejection text is filtered: only [Rule N] / loop-break lines emit',
    fn: () => withTmpEnv((env) => {
      writeTranscriptFixture(env.projectsDir, 'sesseeee-1111-2222-3333-444455556666', [
        { ts: '2026-05-30T12:00:00Z', reason: '[Rule 1] valid rejection' },
        { ts: '2026-05-30T12:05:00Z', reason: 'random user note not a rejection' },
        { ts: '2026-05-30T12:10:00Z', reason: 'loop-break: deferring to user' },
      ]);
      run(env);
      assert.strictEqual(rejectionEventCount(env.eventsPath), 2,
        'expected 2 entries (Rule 1 + loop-break); the plain-text middle line should be filtered');
    }),
  },

  {
    name: '--source=log limits scan to supervisor-log only',
    fn: () => withTmpEnv((env) => {
      writeTranscriptFixture(env.projectsDir, 'sessffff-1111-2222-3333-444455556666', [
        { ts: '2026-05-30T12:00:00Z', reason: '[Rule 1] should be skipped' },
      ]);
      fs.writeFileSync(env.logPath,
        '- **2026-05-30 13:00:00** | `def45678` | Layer3a-rejection | [Rule 3] log-only test\n');
      run(env, ['--source=log']);
      assert.strictEqual(rejectionEventCount(env.eventsPath), 1,
        'with --source=log, transcript candidates must be ignored');
    }),
  },
];

module.exports = { tests };

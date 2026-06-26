// Unit tests for rh-learning-loop.js — daily aggregation of oversight events.
//
// rh-learning-loop.js exports the pure-ish functions (groupKey, buildGroups,
// readEventsSince, checkSameDayGuard, readOpenProposedFingerprints) for direct
// require. Tests use that surface — no subprocess needed.
//
// IMPORTANT: env vars OVERSIGHT_EVENTS_PATH + HOME affect module-load-time
// path resolution. Set them BEFORE require. Each test that touches file paths
// is isolated to a tmp dir.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Set env BEFORE the module loads so its module-load-time path resolution
// targets a sandbox tmp dir. Save originals so we can restore AFTER require —
// otherwise CLAUDE_DIR + OVERSIGHT_EVENTS_PATH leak into the inherited env of
// subprocesses spawned by alphabetically-later test files (e.g. scribe-staging-
// read.js) and break their HOME isolation.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-learning-loop-test-'));
fs.mkdirSync(path.join(TMP_HOME, '.claude'), { recursive: true });
const _origEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CLAUDE_DIR: process.env.CLAUDE_DIR,
  OVERSIGHT_EVENTS_PATH: process.env.OVERSIGHT_EVENTS_PATH,
};
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
process.env.CLAUDE_DIR = path.join(TMP_HOME, '.claude');
const TMP_EVENTS = path.join(TMP_HOME, '.claude', 'oversight-events.jsonl');
process.env.OVERSIGHT_EVENTS_PATH = TMP_EVENTS;

// Force config re-resolution against our tmp HOME (clears any cache set by
// test-config.js or another suite that loaded first).
require('../scripts/lib/config').resetCache();

const {
  buildGroups,
  groupKey,
  readEventsSince,
  checkSameDayGuard,
  readOpenProposedFingerprints,
} = require('../scripts/rh-learning-loop');

// Restore env so later test files in the runner don't inherit our overrides.
// The rh-learning-loop module captured EVENTS_PATH / LAST_RUN_FILE at load
// time, so its functions keep using the tmp paths regardless of env state now.
for (const [k, v] of Object.entries(_origEnv)) {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

const tests = [
  // ─────────── groupKey ───────────
  {
    name: 'groupKey: oversight_auto_inject sorts missing_elements + joins with +',
    fn: () => {
      const k = groupKey({
        event_type: 'oversight_auto_inject',
        data: { subagent_type: 'rh-supervisor', missing_elements: ['zeta', 'alpha', 'gamma'] },
      });
      assert.strictEqual(k, 'rh-supervisor::alpha+gamma+zeta');
    },
  },
  {
    name: 'groupKey: oversight_auto_inject with no subagent_type uses ∅ placeholder',
    fn: () => {
      const k = groupKey({
        event_type: 'oversight_auto_inject',
        data: { missing_elements: ['a'] },
      });
      assert.strictEqual(k, '∅::a');
    },
  },
  {
    name: 'groupKey: layer3a_rejection extracts Rule N',
    fn: () => {
      const k = groupKey({
        event_type: 'layer3a_rejection',
        data: { reason: 'Rule 1 — declared done without outer-seam verification' },
      });
      assert.ok(k.startsWith('rule1::'), `expected rule1 prefix, got ${k}`);
    },
  },
  {
    name: 'groupKey: layer3a_rejection without explicit Rule N uses ? marker',
    fn: () => {
      const k = groupKey({
        event_type: 'layer3a_rejection',
        data: { reason: 'something else entirely' },
      });
      assert.ok(k.startsWith('rule?::'), `expected rule? prefix, got ${k}`);
    },
  },
  {
    name: 'groupKey: layer3a_rejection truncates reason at 60 chars',
    fn: () => {
      const long = 'Rule 1 — ' + 'x'.repeat(200);
      const k = groupKey({
        event_type: 'layer3a_rejection',
        data: { reason: long },
      });
      // The slice(0,60) caps the reason portion
      const reasonPart = k.split('::')[1];
      assert.ok(reasonPart.length <= 60, `reason should be ≤60 chars, got ${reasonPart.length}`);
    },
  },
  {
    name: 'groupKey: unknown event_type falls back to JSON.stringify(data).slice(0,80)',
    fn: () => {
      const k = groupKey({ event_type: 'other_thing', data: { foo: 'bar' } });
      assert.strictEqual(k, '{"foo":"bar"}');
    },
  },

  // ─────────── buildGroups ───────────
  {
    name: 'buildGroups: empty events → empty result',
    fn: () => {
      assert.deepStrictEqual(buildGroups([]), []);
    },
  },
  {
    name: 'buildGroups: below threshold (consolidation_blocked min=3, only 2 events) → excluded',
    fn: () => {
      const events = [
        { event_type: 'consolidation_blocked', timestamp: '2026-05-01T00:00:00Z', data: { reason: 'x', session_id: 's1' } },
        { event_type: 'consolidation_blocked', timestamp: '2026-05-01T01:00:00Z', data: { reason: 'x', session_id: 's1' } },
      ];
      assert.deepStrictEqual(buildGroups(events), []);
    },
  },
  {
    name: 'buildGroups: at threshold (consolidation_blocked min=3, 3 events same key) → included',
    fn: () => {
      // groupKey for non-special event types is JSON.stringify(data).slice(0,80).
      // So events must have IDENTICAL data to cluster into one group.
      // (Multi-session aggregation only works for special-cased event types like
      // oversight_auto_inject + layer3a_rejection where groupKey is computed
      // independently of session_id.)
      const data = { reason: 'same', session_id: 's1' };
      const events = [
        { event_type: 'consolidation_blocked', timestamp: '2026-05-01T00:00:00Z', data },
        { event_type: 'consolidation_blocked', timestamp: '2026-05-01T01:00:00Z', data },
        { event_type: 'consolidation_blocked', timestamp: '2026-05-01T02:00:00Z', data },
      ];
      const groups = buildGroups(events);
      assert.strictEqual(groups.length, 1);
      assert.strictEqual(groups[0].event_type, 'consolidation_blocked');
      assert.strictEqual(groups[0].count, 3);
      assert.strictEqual(groups[0].distinct_sessions, 1);
    },
  },
  {
    name: 'buildGroups: oversight_auto_inject requires multi-session (5 events same session → excluded)',
    fn: () => {
      const events = Array.from({ length: 5 }, (_, i) => ({
        event_type: 'oversight_auto_inject',
        timestamp: `2026-05-01T0${i}:00:00Z`,
        data: { subagent_type: 'rh-x', missing_elements: ['a'], session_id: 's1' },
      }));
      assert.deepStrictEqual(buildGroups(events), [],
        'single-session events should be excluded for multi-session-required type');
    },
  },
  {
    name: 'buildGroups: oversight_auto_inject 5+ events across 2+ sessions → included',
    fn: () => {
      const events = [
        { event_type: 'oversight_auto_inject', timestamp: '2026-05-01T00:00:00Z', data: { subagent_type: 'rh-x', missing_elements: ['a'], session_id: 's1' } },
        { event_type: 'oversight_auto_inject', timestamp: '2026-05-01T01:00:00Z', data: { subagent_type: 'rh-x', missing_elements: ['a'], session_id: 's1' } },
        { event_type: 'oversight_auto_inject', timestamp: '2026-05-01T02:00:00Z', data: { subagent_type: 'rh-x', missing_elements: ['a'], session_id: 's2' } },
        { event_type: 'oversight_auto_inject', timestamp: '2026-05-01T03:00:00Z', data: { subagent_type: 'rh-x', missing_elements: ['a'], session_id: 's2' } },
        { event_type: 'oversight_auto_inject', timestamp: '2026-05-01T04:00:00Z', data: { subagent_type: 'rh-x', missing_elements: ['a'], session_id: 's3' } },
      ];
      const groups = buildGroups(events);
      assert.strictEqual(groups.length, 1);
      assert.strictEqual(groups[0].count, 5);
      assert.strictEqual(groups[0].distinct_sessions, 3);
    },
  },
  {
    name: 'buildGroups: sorts by count descending',
    fn: () => {
      const events = [
        // group A: 4 events
        ...Array.from({ length: 4 }, (_, i) => ({
          event_type: 'layer3a_rejection',
          timestamp: `2026-05-01T0${i}:00:00Z`,
          data: { reason: 'Rule 1 — A', session_id: `s${i}` },
        })),
        // group B: 3 events
        ...Array.from({ length: 3 }, (_, i) => ({
          event_type: 'layer3a_rejection',
          timestamp: `2026-05-02T0${i}:00:00Z`,
          data: { reason: 'Rule 2 — B', session_id: `t${i}` },
        })),
      ];
      const groups = buildGroups(events);
      assert.strictEqual(groups.length, 2);
      assert.ok(groups[0].count >= groups[1].count, 'must be sorted desc by count');
      assert.strictEqual(groups[0].count, 4);
      assert.strictEqual(groups[1].count, 3);
    },
  },
  {
    name: 'buildGroups: unknown event_type → excluded (not in THRESHOLDS)',
    fn: () => {
      const events = Array.from({ length: 10 }, (_, i) => ({
        event_type: 'random_event_type',
        timestamp: `2026-05-01T0${i}:00:00Z`,
        data: { session_id: `s${i}` },
      }));
      assert.deepStrictEqual(buildGroups(events), []);
    },
  },

  // ─────────── readEventsSince ───────────
  {
    name: 'readEventsSince: missing file → []',
    fn: () => {
      try { fs.unlinkSync(TMP_EVENTS); } catch {}
      assert.deepStrictEqual(readEventsSince(0), []);
    },
  },
  {
    name: 'readEventsSince: filters by cutoffMs (events older than cutoff dropped)',
    fn: () => {
      const old = { event_type: 'x', timestamp: '2025-01-01T00:00:00Z', data: {} };
      const fresh = { event_type: 'y', timestamp: '2030-01-01T00:00:00Z', data: {} };
      fs.writeFileSync(TMP_EVENTS, JSON.stringify(old) + '\n' + JSON.stringify(fresh) + '\n');
      const cutoff = Date.parse('2026-01-01T00:00:00Z');
      const r = readEventsSince(cutoff);
      assert.strictEqual(r.length, 1, `expected 1 event past cutoff, got ${r.length}`);
      assert.strictEqual(r[0].event_type, 'y');
    },
  },
  {
    name: 'readEventsSince: malformed JSON lines are skipped (no crash)',
    fn: () => {
      const good = { event_type: 'g', timestamp: '2030-01-01T00:00:00Z', data: {} };
      fs.writeFileSync(TMP_EVENTS,
        'not json at all\n' +
        '{"truncated":\n' +
        JSON.stringify(good) + '\n' +
        '\n'
      );
      const r = readEventsSince(0);
      assert.strictEqual(r.length, 1);
      assert.strictEqual(r[0].event_type, 'g');
    },
  },

  // ─────────── readOpenProposedFingerprints ───────────
  {
    name: 'readOpenProposedFingerprints: missing file → empty Set',
    fn: () => {
      const fp = readOpenProposedFingerprints(path.join(TMP_HOME, 'no-such.md'));
      assert.ok(fp instanceof Set);
      assert.strictEqual(fp.size, 0);
    },
  },
  {
    name: 'readOpenProposedFingerprints: parses open learning-loop rows with event_type + group_key tokens',
    fn: () => {
      const recsPath = path.join(TMP_HOME, 'recommendations.md');
      const content = [
        '| id | ts | session | text | status |',
        '|---|---|---|---|---|',
        '| 1 | 2026-05-10 | learning-loop | Pattern: event_type=layer3a_rejection group_key=rule1::xx | open |',
        '| 2 | 2026-05-10 | learning-loop | Pattern: event_type=consolidation_blocked group_key=foo | open |',
        '| 3 | 2026-05-10 | learning-loop | Pattern: event_type=other group_key=bar | resolved |',
        '| 4 | 2026-05-10 | manual-entry | Not a learning-loop row | open |',
      ].join('\n');
      fs.writeFileSync(recsPath, content);
      const fp = readOpenProposedFingerprints(recsPath);
      assert.ok(fp.has('layer3a_rejection|rule1::xx'), `missing first fingerprint; set=${[...fp]}`);
      assert.ok(fp.has('consolidation_blocked|foo'));
      assert.ok(!fp.has('other|bar'), 'resolved rows should NOT be in the fingerprint set');
      assert.ok(![...fp].some(f => f.includes('manual-entry')),
        'non-learning-loop rows should be skipped');
      assert.strictEqual(fp.size, 2);
    },
  },
  {
    name: 'readOpenProposedFingerprints: skips scribe-done sentinel rows',
    fn: () => {
      const recsPath = path.join(TMP_HOME, 'recs-done.md');
      const content = [
        '| id | ts | session | text | status |',
        '|---|---|---|---|---|',
        '| 1 | 2026-05-10 | learning-loop | event_type=x group_key=y <!-- scribe-done --> | open |',
      ].join('\n');
      fs.writeFileSync(recsPath, content);
      const fp = readOpenProposedFingerprints(recsPath);
      assert.strictEqual(fp.size, 0, 'scribe-done rows must be ignored');
    },
  },

  // ─────────── checkSameDayGuard ───────────
  {
    name: 'checkSameDayGuard: missing LAST_RUN_FILE → skip:false',
    fn: () => {
      const guardPath = path.join(TMP_HOME, '.claude', 'learning-loop-last-run.txt');
      try { fs.unlinkSync(guardPath); } catch {}
      const r = checkSameDayGuard();
      assert.strictEqual(r.skip, false);
    },
  },
  {
    name: 'checkSameDayGuard: recent mtime (just-now) → skip:true with ageHours',
    fn: () => {
      const guardPath = path.join(TMP_HOME, '.claude', 'learning-loop-last-run.txt');
      fs.writeFileSync(guardPath, new Date().toISOString() + '\n');
      const r = checkSameDayGuard();
      assert.strictEqual(r.skip, true);
      assert.ok(r.ageHours !== undefined, 'ageHours should be reported');
    },
  },
  {
    name: 'checkSameDayGuard: old mtime (older than 20h guard) → skip:false',
    fn: () => {
      const guardPath = path.join(TMP_HOME, '.claude', 'learning-loop-last-run.txt');
      fs.writeFileSync(guardPath, '');
      // Backdate mtime to 25h ago
      const oldTime = Date.now() - 25 * 3600 * 1000;
      fs.utimesSync(guardPath, oldTime / 1000, oldTime / 1000);
      const r = checkSameDayGuard();
      assert.strictEqual(r.skip, false);
    },
  },
];

// Cleanup tmp on suite-load completion (registered via process.on('exit') for safety)
process.on('exit', () => {
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch {}
});

module.exports = { tests };

// Behavioral tests for rh-scribe-prefilter.js — the Stop-hook inline scribe
// extractor (2026-07-06 hardening: headless self-capture suppression,
// JSON-snippet skip, self-reference skip, REC marker tightening, header
// self-heal).
//
// Spawn-based (the script runs its effect on load via wrapHook and has no
// exports), so we feed crafted hook payloads on stdin with HOME/USERPROFILE/
// CLAUDE_DIR pointed at a tmp home and CLAUDE_WORKSPACE at a tmp workspace,
// then assert on the recommendations.md / cleanup.md / learnings.md files the
// hook writes. OVERSIGHT_SELF_TEST=1 suppresses the timing-telemetry side
// channel. Each test gets a fresh tmp home + workspace, so the loop-guard
// flag, back-off state, and session markers never leak between tests.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'rh-scribe-prefilter.js');
const SENTINEL = '<!-- scribe-done -->';
const TABLE_HEADER = '| id | ts | session | text | status |';

function withTmpEnv(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-prefilter-test-'));
  const home = path.join(root, 'home');
  const ws = path.join(root, 'ws');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(ws, { recursive: true });
  try { return fn({ root, home, ws }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// Build a minimal JSONL transcript whose assistant turns carry the given texts.
function writeTranscript(root, assistantTexts) {
  const p = path.join(root, 'transcript.jsonl');
  const lines = assistantTexts.map(t => JSON.stringify({
    message: { role: 'assistant', content: [{ type: 'text', text: t }] },
  }));
  fs.writeFileSync(p, lines.join('\n') + '\n', 'utf8');
  return p;
}

function runHook({ home, ws }, transcriptPath, sessionId, extraEnv = {}) {
  const input = JSON.stringify({ transcript_path: transcriptPath, session_id: sessionId });
  const r = spawnSync('node', [SCRIPT], {
    input, encoding: 'utf8', timeout: 10000, windowsHide: true,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CLAUDE_DIR: path.join(home, '.claude'),
      CLAUDE_WORKSPACE: ws,
      OVERSIGHT_SELF_TEST: '1',
      RH_SCRIBE_DB: '0',
      RH_CONTEXT_DB: '0',
      CLAUDE_SCRIBE_SUPPRESS: '',   // explicit default; tests override
      ...extraEnv,
    },
  });
  assert.strictEqual(r.status, 0, `hook exited ${r.status}: ${(r.stderr || '').slice(0, 300)}`);
  return { stdout: r.stdout || '', stderr: r.stderr || '' };
}

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);

const tests = [
  {
    name: 'control: an explicit recommendation sentence is captured into recommendations.md (with canonical header + sentinel)',
    fn: () => withTmpEnv((env) => {
      const t = writeTranscript(env.root, [
        'I recommend adding a retry guard to the telemetry forwarder so repeated timeouts stop burning turns.',
      ]);
      const { stdout } = runHook(env, t, 'sess-control-0001');
      assert.strictEqual(stdout.trim(), '{}', 'hook is non-blocking');
      const rec = read(path.join(env.ws, 'recommendations.md'));
      assert.ok(rec, 'recommendations.md must be created');
      assert.ok(rec.includes('retry guard'), 'the recommendation snippet must be captured');
      // Header self-heal on a previously-missing file:
      assert.ok(rec.startsWith('# Recommendations (cross-session scribe log)'),
        `canonical header expected at top; got: ${rec.slice(0, 80)}`);
      assert.ok(rec.includes(TABLE_HEADER), 'table-header line present');
      const lines = rec.split('\n').filter(Boolean);
      assert.strictEqual(lines[lines.length - 1], SENTINEL, 'single sentinel at EOF');
      assert.strictEqual((rec.match(/<!-- scribe-done -->/g) || []).length, 1, 'exactly one sentinel');
    }),
  },
  {
    name: 'CLAUDE_SCRIBE_SUPPRESS=1 early-exits before ANY write (no md rows, no staging, no flags)',
    fn: () => withTmpEnv((env) => {
      const t = writeTranscript(env.root, [
        'I recommend adding a retry guard to the telemetry forwarder so repeated timeouts stop burning turns.',
        'TODO: remove the stale temp directory leftover from the failed migration run.',
      ]);
      const { stdout } = runHook(env, t, 'sess-suppress-001', { CLAUDE_SCRIBE_SUPPRESS: '1' });
      assert.strictEqual(stdout.trim(), '{}', 'suppressed hook still returns {}');
      assert.strictEqual(read(path.join(env.ws, 'recommendations.md')), null, 'no recommendations.md');
      assert.strictEqual(read(path.join(env.ws, 'cleanup.md')), null, 'no cleanup.md');
      assert.strictEqual(read(path.join(env.ws, 'learnings.md')), null, 'no learnings.md');
      const claudeDir = path.join(env.home, '.claude');
      assert.ok(!fs.existsSync(path.join(claudeDir, 'scribe-staging')),
        'staging must not run under suppression (early-exit precedes staging)');
      const flags = fs.readdirSync(claudeDir).filter(f => f.startsWith('scribe-pending-'));
      assert.deepStrictEqual(flags, [], 'no loop-guard flag written under suppression');
      assert.ok(!fs.existsSync(path.join(claudeDir, 'rh-scribe-inline.jsonl')),
        'no inline-telemetry record under suppression');
    }),
  },
  {
    name: 'JSON-shaped snippet ({"row_id":...} triage output) produces 0 rows; prose in the same turn still captured',
    fn: () => withTmpEnv((env) => {
      const t = writeTranscript(env.root, [
        '[{"row_id":"ab12cd34","disposition":"resolve","rationale":"recommend closing this stale cleanup row"}]',
        'I recommend documenting the dispatch timeout budget in the runbook for the next session.',
      ]);
      runHook(env, t, 'sess-json-000001');
      const rec = read(path.join(env.ws, 'recommendations.md'));
      assert.ok(rec, 'recommendations.md created for the genuine prose recommendation');
      assert.ok(rec.includes('dispatch timeout budget'), 'prose recommendation captured');
      assert.ok(!rec.includes('row_id'), 'triage JSON must NOT be captured into recommendations.md');
      const clean = read(path.join(env.ws, 'cleanup.md'));
      if (clean) {
        assert.ok(!clean.includes('row_id'), 'triage JSON must NOT be captured into cleanup.md');
      }
    }),
  },
  {
    name: 'JSON-only transcript (pure triage output) creates NO scribe files at all',
    fn: () => withTmpEnv((env) => {
      const t = writeTranscript(env.root, [
        '[{"row_id":"ab12cd34","disposition":"resolve","rationale":"recommend closing; stale cleanup row from prior run"},{"row_id":"ef56ab78","disposition":"still-open","rationale":"suggest keeping until the TODO lands"}]',
      ]);
      runHook(env, t, 'sess-jsononly-001');
      assert.strictEqual(read(path.join(env.ws, 'recommendations.md')), null, 'no recommendations.md');
      assert.strictEqual(read(path.join(env.ws, 'cleanup.md')), null, 'no cleanup.md');
      assert.strictEqual(read(path.join(env.ws, 'learnings.md')), null, 'no learnings.md');
    }),
  },
  {
    name: 'belt-and-braces: a sentence carrying {"row_id": ...} mid-text is skipped even when not JSON-shaped',
    fn: () => withTmpEnv((env) => {
      const t = writeTranscript(env.root, [
        'The triage emitted {"row_id": "ab12cd34"} and I recommend never capturing that fragment as a row.',
      ]);
      runHook(env, t, 'sess-rowid-00001');
      assert.strictEqual(read(path.join(env.ws, 'recommendations.md')), null,
        'row_id-bearing sentence must be skipped');
    }),
  },
  {
    name: 'self-referential scribe bookkeeping skipped; genuine "delete the stale cleanup.md" action item STILL captured',
    fn: () => withTmpEnv((env) => {
      const t = writeTranscript(env.root, [
        'Scribe summary: 3 new rows appended to cleanup.md → done for this turn.',
        'TODO: delete the stale cleanup.md in project X before the next release lands.',
      ]);
      runHook(env, t, 'sess-selfref-0001');
      const clean = read(path.join(env.ws, 'cleanup.md'));
      assert.ok(clean, 'cleanup.md must be created for the genuine action item');
      assert.ok(clean.includes('delete the stale cleanup.md in project X'),
        'the counter-example action item MUST be captured');
      assert.ok(!clean.includes('rows appended to cleanup.md'),
        'the bookkeeping sentence must NOT be captured');
    }),
  },
  {
    name: 'REC_MARKERS tightened: bare should/consider/improve sentences are no longer captured; suggest still is',
    fn: () => withTmpEnv((env) => {
      const t = writeTranscript(env.root, [
        'You should probably take a look at the config file when you have a spare moment.',
        'Consider that the tests were green and everything looked fine on the first pass.',
        'We can improve the wording of that comment at some point in the future maybe.',
      ]);
      runHook(env, t, 'sess-tighten-001');
      assert.strictEqual(read(path.join(env.ws, 'recommendations.md')), null,
        'bare should/consider/improve sentences must not create recommendations.md');

      const t2 = writeTranscript(env.root, [
        'I suggest pinning the playwright version in the visual-verification pipeline configuration.',
      ]);
      runHook(env, t2, 'sess-tighten-002');
      const rec = read(path.join(env.ws, 'recommendations.md'));
      assert.ok(rec && rec.includes('pinning the playwright version'),
        'explicit suggest-sentences are still captured');
    }),
  },
  {
    name: 'header self-heal: existing HEADERLESS cleanup.md gains the canonical header; rows + sentinel preserved',
    fn: () => withTmpEnv((env) => {
      const cleanupPath = path.join(env.ws, 'cleanup.md');
      fs.writeFileSync(cleanupPath,
        '| oldrow01 | 2026-06-01 | sess | pre-existing headerless row | open |\n' + SENTINEL + '\n', 'utf8');
      const t = writeTranscript(env.root, [
        'TODO: remove the stale temp directory leftover from the failed migration run.',
      ]);
      runHook(env, t, 'sess-selfheal-01');
      const clean = read(cleanupPath);
      assert.ok(clean.startsWith('# Cleanup items (cross-session scribe log)'),
        `canonical header expected at top; got: ${clean.slice(0, 80)}`);
      assert.ok(clean.includes(TABLE_HEADER), 'table-header line present');
      assert.ok(clean.includes('| oldrow01 |'), 'pre-existing row preserved');
      assert.ok(clean.includes('stale temp directory'), 'new row appended');
      assert.strictEqual((clean.match(/<!-- scribe-done -->/g) || []).length, 1, 'exactly one sentinel');
      const headerIdx = clean.indexOf(TABLE_HEADER);
      const oldRowIdx = clean.indexOf('| oldrow01 |');
      assert.ok(headerIdx < oldRowIdx, 'header block precedes existing rows');
    }),
  },
  {
    name: 'header self-heal: file that already has a header is untouched (no duplicate header block)',
    fn: () => withTmpEnv((env) => {
      const cleanupPath = path.join(env.ws, 'cleanup.md');
      fs.writeFileSync(cleanupPath,
        '# Cleanup items (cross-session scribe log)\n\n' +
        'Schema: `id | ts | session | text | status`. Status is `open` by default; flips via triage dispositions or /rh-quit curation. Forward-looking — capture what needs follow-up.\n\n' +
        TABLE_HEADER + '\n|---|---|---|---|---|\n' +
        '| existing1 | 2026-06-01 | sess | already-headed row | open |\n' + SENTINEL + '\n', 'utf8');
      const t = writeTranscript(env.root, [
        'TODO: remove the stale temp directory leftover from the failed migration run.',
      ]);
      runHook(env, t, 'sess-selfheal-02');
      const clean = read(cleanupPath);
      const titleCount = (clean.match(/# Cleanup items \(cross-session scribe log\)/g) || []).length;
      assert.strictEqual(titleCount, 1, `header must not be duplicated; got ${titleCount}`);
      const headerLineCount = clean.split('\n').filter(l => l.trim().startsWith('| id | ts | session |')).length;
      assert.strictEqual(headerLineCount, 1, 'exactly one table-header line');
      assert.ok(clean.includes('| existing1 |'), 'existing row preserved');
      assert.ok(clean.includes('stale temp directory'), 'new row appended');
    }),
  },
];

module.exports = { tests };

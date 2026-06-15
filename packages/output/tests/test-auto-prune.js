// Unit tests for rh-auto-prune.js — daily cleanup pass for ephemeral
// artifacts (settings backups, scribe-pending flags, subagent-active flags,
// stale session markers, scribe-staging files) plus scribe row archiving
// for status=resolved+old and stale-open alerting.
//
// Safety contract: dry-run by default; --apply required for mutations.
// Tests verify both modes against tmp-HOME fixtures with backdated mtimes.

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'rh-auto-prune.js');
const DAY_MS = 24 * 3600 * 1000;

function withTmpEnv(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-auto-prune-test-'));
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(path.join(claudeDir, 'scribe-staging'), { recursive: true });
  // The workspace is `home` itself (CLAUDE_WORKSPACE=home). Scribe files live there.
  try { return fn({ home, claudeDir }); }
  finally { fs.rmSync(home, { recursive: true, force: true }); }
}

function runScript({ home, claudeDir }, args = []) {
  const r = spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8', timeout: 10000, windowsHide: true,
    env: {
      ...process.env,
      HOME: home, USERPROFILE: home,
      CLAUDE_DIR: claudeDir,
      CLAUDE_WORKSPACE: home,
    },
  });
  return { exitCode: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function backdate(filePath, days) {
  const t = (Date.now() - days * DAY_MS) / 1000;
  fs.utimesSync(filePath, t, t);
}

const tests = [
  // ───────── --json output shape ─────────
  {
    name: '--json: produces valid JSON with all expected top-level keys',
    fn: () => withTmpEnv((env) => {
      const r = runScript(env, ['--json']);
      assert.strictEqual(r.exitCode, 0, `stderr: ${r.stderr}`);
      const obj = JSON.parse(r.stdout);
      assert.strictEqual(obj.mode, 'dry-run');
      assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(obj.timestamp), 'timestamp must be ISO');
      for (const k of ['settings_backups', 'scribe_pending_flags',
                       'subagent_active_flags', 'session_markers',
                       'scribe_staging', 'scribe_files']) {
        assert.ok(k in obj, `expected key "${k}"`);
      }
      assert.ok(Array.isArray(obj.scribe_files));
    }),
  },

  // ───────── settings backups pruning ─────────
  {
    name: 'settings backups: 7 files → kept 5, candidates 2 (dry-run reports, does not delete)',
    fn: () => withTmpEnv((env) => {
      // Seed 7 backup files with staggered mtimes
      const files = [];
      for (let i = 0; i < 7; i++) {
        const f = path.join(env.claudeDir, `settings.json.bak${i}`);
        fs.writeFileSync(f, `backup ${i}`);
        files.push(f);
        backdate(f, i);  // backup0 = today, backup6 = 6 days old
      }
      const r = runScript(env, ['--json']);
      const obj = JSON.parse(r.stdout);
      assert.strictEqual(obj.settings_backups.kept, 5);
      assert.strictEqual(obj.settings_backups.candidates, 2);
      assert.strictEqual(obj.settings_backups.removed, 0, 'dry-run should not remove');
      // All 7 files still exist
      for (const f of files) assert.ok(fs.existsSync(f));
    }),
  },
  {
    name: 'settings backups: --apply removes 2 oldest of 7',
    fn: () => withTmpEnv((env) => {
      const files = [];
      for (let i = 0; i < 7; i++) {
        const f = path.join(env.claudeDir, `settings.json.bak${i}`);
        fs.writeFileSync(f, `backup ${i}`);
        files.push(f);
        backdate(f, i);
      }
      const r = runScript(env, ['--apply', '--json']);
      assert.strictEqual(r.exitCode, 0, `stderr: ${r.stderr}`);
      const obj = JSON.parse(r.stdout);
      assert.strictEqual(obj.settings_backups.removed, 2);
      // The 2 oldest (bak5, bak6) should be gone
      const remaining = fs.readdirSync(env.claudeDir).filter(f => f.startsWith('settings.json.bak'));
      assert.strictEqual(remaining.length, 5, `expected 5 remaining; got ${remaining.length}`);
    }),
  },

  // ───────── scribe-pending flag pruning ─────────
  {
    name: 'scribe-pending flags: <24h old kept, >24h old removed in --apply',
    fn: () => withTmpEnv((env) => {
      const fresh = path.join(env.claudeDir, 'scribe-pending-fresh.flag');
      const old = path.join(env.claudeDir, 'scribe-pending-old.flag');
      fs.writeFileSync(fresh, '');
      fs.writeFileSync(old, '');
      backdate(fresh, 0.5);  // 12h old → kept
      backdate(old, 2);      // 48h old → removed
      const r = runScript(env, ['--apply', '--json']);
      const obj = JSON.parse(r.stdout);
      assert.strictEqual(obj.scribe_pending_flags.candidates, 1, 'only the old one is a candidate');
      assert.strictEqual(obj.scribe_pending_flags.removed, 1);
      assert.ok(fs.existsSync(fresh), 'fresh flag should survive');
      assert.ok(!fs.existsSync(old), 'old flag should be removed');
    }),
  },

  // ───────── subagent-active flag pruning ─────────
  {
    name: 'subagent-active flags: >24h removed (same age policy as scribe-pending)',
    fn: () => withTmpEnv((env) => {
      const old = path.join(env.claudeDir, 'subagent-active-abc.flag');
      fs.writeFileSync(old, '');
      backdate(old, 5);  // 5d old
      const r = runScript(env, ['--apply', '--json']);
      const obj = JSON.parse(r.stdout);
      assert.strictEqual(obj.subagent_active_flags.candidates, 1);
      assert.strictEqual(obj.subagent_active_flags.removed, 1);
      assert.ok(!fs.existsSync(old));
    }),
  },

  // ───────── session marker pruning ─────────
  {
    name: 'session markers: old startedAt → flagged stale + removed in --apply',
    fn: () => withTmpEnv((env) => {
      const oldMarker = path.join(env.claudeDir, 'session-marker-abc.json');
      // startedAt 45 days ago → past the 30d cutoff
      const oldTs = new Date(Date.now() - 45 * DAY_MS).toISOString();
      fs.writeFileSync(oldMarker, JSON.stringify({ startedAt: oldTs, sessionId: 'abc' }));
      const r = runScript(env, ['--apply', '--json']);
      const obj = JSON.parse(r.stdout);
      assert.strictEqual(obj.session_markers.candidates, 1);
      assert.strictEqual(obj.session_markers.removed, 1);
      assert.ok(!fs.existsSync(oldMarker));
    }),
  },
  {
    name: 'session markers: recent startedAt is preserved',
    fn: () => withTmpEnv((env) => {
      const recentMarker = path.join(env.claudeDir, 'session-marker-recent.json');
      const recentTs = new Date(Date.now() - 5 * DAY_MS).toISOString();
      fs.writeFileSync(recentMarker, JSON.stringify({ startedAt: recentTs }));
      const r = runScript(env, ['--apply', '--json']);
      const obj = JSON.parse(r.stdout);
      assert.strictEqual(obj.session_markers.candidates, 0);
      assert.ok(fs.existsSync(recentMarker));
    }),
  },
  {
    name: 'session markers: unparseable startedAt → falls back to mtime',
    fn: () => withTmpEnv((env) => {
      const garbage = path.join(env.claudeDir, 'session-marker-garbage.json');
      fs.writeFileSync(garbage, '{not-json: yes');  // unparseable
      backdate(garbage, 45);  // 45 days old by mtime
      const r = runScript(env, ['--apply', '--json']);
      const obj = JSON.parse(r.stdout);
      assert.strictEqual(obj.session_markers.candidates, 1,
        'mtime fallback should flag old garbage marker');
      assert.ok(!fs.existsSync(garbage));
    }),
  },

  // ───────── scribe row archiving ─────────
  {
    name: 'scribe rows: resolved+old → archived to Archive/scribe-archive-YYYY-MM.md',
    fn: () => withTmpEnv((env) => {
      const cleanupMd = path.join(env.home, 'cleanup.md');
      const oldDate = new Date(Date.now() - 30 * DAY_MS).toISOString().slice(0, 10);
      const newDate = new Date().toISOString().slice(0, 10);
      const content = [
        '| id | ts | session | text | status |',
        '|---|---|---|---|---|',
        `| abcdef01 | ${oldDate} | sess1234 | old resolved item | resolved |`,
        `| cafef001 | ${newDate} | sess5678 | recent item | open |`,
      ].join('\n') + '\n';
      fs.writeFileSync(cleanupMd, content);
      const r = runScript(env, ['--apply', '--json']);
      assert.strictEqual(r.exitCode, 0, `stderr: ${r.stderr}`);
      const obj = JSON.parse(r.stdout);
      const cleanupResult = obj.scribe_files.find(f => f.file === 'cleanup.md');
      assert.strictEqual(cleanupResult.archived_count, 1);
      assert.ok(cleanupResult.archived_ids.includes('abcdef01'));
      // The old row is gone from cleanup.md
      const newContent = fs.readFileSync(cleanupMd, 'utf-8');
      assert.ok(!newContent.includes('abcdef01'), 'archived row should be removed from source file');
      assert.ok(newContent.includes('cafef001'), 'recent row should remain');
      // Archive file exists
      const archiveDir = path.join(env.home, 'Archive');
      assert.ok(fs.existsSync(archiveDir), 'Archive dir should be created');
      const archiveFiles = fs.readdirSync(archiveDir).filter(f => f.startsWith('scribe-archive-'));
      assert.strictEqual(archiveFiles.length, 1, 'one archive file expected');
      const archiveContent = fs.readFileSync(path.join(archiveDir, archiveFiles[0]), 'utf-8');
      assert.ok(archiveContent.includes('abcdef01'),
        'archived row content must land in the archive file');
    }),
  },
  {
    name: 'scribe rows: open+old → stale_open_count reported (event emitted in apply)',
    fn: () => withTmpEnv((env) => {
      const recsMd = path.join(env.home, 'recommendations.md');
      const veryOldDate = new Date(Date.now() - 60 * DAY_MS).toISOString().slice(0, 10);
      const content = [
        '| id | ts | session | text | status |',
        '|---|---|---|---|---|',
        `| dead0001 | ${veryOldDate} | s1 | very old open item | open |`,
        `| dead0002 | ${veryOldDate} | s2 | another stale open | open |`,
      ].join('\n') + '\n';
      fs.writeFileSync(recsMd, content);
      const r = runScript(env, ['--apply', '--json']);
      const obj = JSON.parse(r.stdout);
      const result = obj.scribe_files.find(f => f.file === 'recommendations.md');
      assert.strictEqual(result.stale_open_count, 2);
      assert.deepStrictEqual(result.stale_open_ids.sort(), ['dead0001', 'dead0002'].sort());
      // Open rows are NOT removed from the file (just flagged via event)
      const newContent = fs.readFileSync(recsMd, 'utf-8');
      assert.ok(newContent.includes('dead0001'), 'open rows should NOT be archived, just flagged');
    }),
  },
  {
    name: 'scribe rows: dry-run reports counts but does not modify file',
    fn: () => withTmpEnv((env) => {
      const cleanupMd = path.join(env.home, 'cleanup.md');
      const oldDate = new Date(Date.now() - 30 * DAY_MS).toISOString().slice(0, 10);
      const content =
        '| id | ts | session | text | status |\n' +
        '|---|---|---|---|---|\n' +
        `| d2700001 | ${oldDate} | s | should not move | resolved |\n`;
      fs.writeFileSync(cleanupMd, content);
      const r = runScript(env, ['--json']);  // no --apply
      const obj = JSON.parse(r.stdout);
      const result = obj.scribe_files.find(f => f.file === 'cleanup.md');
      assert.strictEqual(result.archived_count, 1, 'count should be reported');
      // But file should NOT be modified
      const after = fs.readFileSync(cleanupMd, 'utf-8');
      assert.strictEqual(after, content, 'dry-run must not modify source file');
      // And no Archive dir created
      assert.ok(!fs.existsSync(path.join(env.home, 'Archive')),
        'dry-run must not create Archive dir');
    }),
  },
  {
    name: 'scribe rows: missing source file → no error, archived_count=0',
    fn: () => withTmpEnv((env) => {
      // No cleanup.md or recommendations.md exist.
      const r = runScript(env, ['--apply', '--json']);
      assert.strictEqual(r.exitCode, 0);
      const obj = JSON.parse(r.stdout);
      for (const f of obj.scribe_files) {
        assert.strictEqual(f.archived_count, 0);
        assert.strictEqual(f.stale_open_count, 0);
      }
    }),
  },

  {
    name: 'C6: prefixed terminal statuses (closed:/stale:) + old → archived (broadened beyond bare resolved)',
    fn: () => withTmpEnv((env) => {
      const cleanupMd = path.join(env.home, 'cleanup.md');
      const oldDate = new Date(Date.now() - 30 * DAY_MS).toISOString().slice(0, 10);
      const content = [
        `| c10dab01 | ${oldDate} | sessAAAA | done last month | closed: shipped in PR #12 (2026-05-01) |`,
        `| 57a1eab2 | ${oldDate} | sessBBBB | aged status note | stale: overtaken by events (2026-05-01) |`,
        `| 0badcab3 | ${oldDate} | sessCCCC | dispositioned via UI | resolved: did it (2026-05-01) |`,
      ].join('\n') + '\n';
      fs.writeFileSync(cleanupMd, content);
      const r = runScript(env, ['--apply', '--json']);
      assert.strictEqual(r.exitCode, 0, `stderr: ${r.stderr}`);
      const res = JSON.parse(r.stdout).scribe_files.find(f => f.file === 'cleanup.md');
      assert.strictEqual(res.archived_count, 3, 'closed:/stale:/resolved: prefixed rows all archive');
      for (const id of ['c10dab01', '57a1eab2', '0badcab3']) assert.ok(res.archived_ids.includes(id), `${id} archived`);
    }),
  },
  {
    name: 'C6: text cell mentions "resolved" but status is open → NOT archived (status-cell-specific)',
    fn: () => withTmpEnv((env) => {
      const cleanupMd = path.join(env.home, 'cleanup.md');
      const oldDate = new Date(Date.now() - 30 * DAY_MS).toISOString().slice(0, 10);
      const content = `| abcd1234 | ${oldDate} | sessDDDD | we have not resolved this yet | open |\n`;
      fs.writeFileSync(cleanupMd, content);
      const r = runScript(env, ['--apply', '--json']);
      const res = JSON.parse(r.stdout).scribe_files.find(f => f.file === 'cleanup.md');
      assert.strictEqual(res.archived_count, 0, 'open row not archived despite "resolved" in text cell');
      assert.strictEqual(res.stale_open_count, 1, 'it is an old open row → stale-flagged instead');
      assert.ok(fs.readFileSync(cleanupMd, 'utf-8').includes('abcd1234'), 'row preserved in source');
    }),
  },

  // ───────── default mode + dry-run safety ─────────
  {
    name: 'default mode (no flags) is dry-run (mode field === "dry-run")',
    fn: () => withTmpEnv((env) => {
      const r = runScript(env, ['--json']);
      const obj = JSON.parse(r.stdout);
      assert.strictEqual(obj.mode, 'dry-run');
    }),
  },
  {
    name: 'pretty (non-JSON) output mentions mode + per-category counts',
    fn: () => withTmpEnv((env) => {
      const r = runScript(env);
      assert.match(r.stdout, /\[auto-prune\] mode=(apply|dry-run)/);
      assert.match(r.stdout, /settings backups:/);
      assert.match(r.stdout, /scribe-pending flags:/);
      assert.match(r.stdout, /subagent-active flags:/);
      assert.match(r.stdout, /session markers/);
      assert.match(r.stdout, /scribe staging/);
    }),
  },
  {
    name: 'pretty output prompts user to re-run with --apply in dry-run mode',
    fn: () => withTmpEnv((env) => {
      const r = runScript(env);
      assert.match(r.stdout, /Re-run with --apply/);
    }),
  },
];

module.exports = { tests };

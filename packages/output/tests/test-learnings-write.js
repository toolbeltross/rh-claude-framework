// Unit tests for rh-learnings-write.js — locked CLI helper for the
// rh-scribe-learnings agent. 4 modes (create / append-observation /
// update-sub-index / update-root-index) — each wraps I/O in withLock.
//
// Spawn the CLI with --mode + JSON payload on stdin, assert on output file
// and CLI status JSON.

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'rh-learnings-write.js');
const SENTINEL = '<!-- scribe-done -->';

function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-lw-test-'));
  try { return fn(dir); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function runCli(args, payload) {
  const r = spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8', timeout: 5000, windowsHide: true,
    input: payload === undefined ? '' : JSON.stringify(payload),
  });
  return { exitCode: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

const tests = [
  // ───────── --mode parsing ─────────
  {
    name: 'missing --mode → exit 1, error JSON to stdout',
    fn: () => {
      const r = runCli([], { topicFile: 'x' });
      assert.strictEqual(r.exitCode, 1);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.ok, false);
      assert.match(out.error, /missing --mode/);
    },
  },
  {
    name: 'unknown --mode → exit 1',
    fn: () => {
      const r = runCli(['--mode', 'invalid'], { x: 1 });
      assert.strictEqual(r.exitCode, 1);
      assert.match(JSON.parse(r.stdout).error, /unknown mode/);
    },
  },
  {
    name: 'empty stdin → exit 1',
    fn: () => {
      const r = spawnSync('node', [SCRIPT, '--mode', 'create'], {
        encoding: 'utf8', timeout: 3000, input: '',
      });
      assert.strictEqual(r.status, 1);
      const out = JSON.parse(r.stdout || '{}');
      assert.match(out.error, /empty stdin/);
    },
  },
  {
    name: 'invalid JSON on stdin → exit 1',
    fn: () => {
      const r = spawnSync('node', [SCRIPT, '--mode', 'create'], {
        encoding: 'utf8', timeout: 3000, input: 'not json',
      });
      assert.strictEqual(r.status, 1);
      assert.match(JSON.parse(r.stdout).error, /invalid JSON/);
    },
  },

  // ───────── mode: create ─────────
  {
    name: 'create: writes new topic file with frontmatter + sections + sentinel',
    fn: () => withTmp((dir) => {
      const topicFile = path.join(dir, 'rh-test-learning.md');
      const r = runCli(['--mode', 'create'], {
        topicFile,
        name: 'Test learning',
        description: 'A test description',
        originSessionId: 'sess-abc',
        created: '2026-05-12',
        learning: 'The lesson body goes here. Multiple sentences allowed.',
        trigger: 'a test trigger',
        decisionRule: '- always test',
        sourceSession: 'sess-abc',
        sourceDate: '2026-05-12',
        transcriptRef: 'ref-location',
      });
      assert.strictEqual(r.exitCode, 0, `stderr: ${r.stderr}; stdout: ${r.stdout}`);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.ok, true);
      assert.strictEqual(out.mode, 'create');
      assert.ok(fs.existsSync(topicFile), 'topic file should exist');
      const content = fs.readFileSync(topicFile, 'utf-8');
      assert.match(content, /^---\nname: "Test learning"/m, 'YAML frontmatter must be at top');
      assert.match(content, /^## Learning$/m);
      assert.match(content, /^## Trigger \/ context$/m);
      assert.match(content, /^## Decision rule$/m);
      assert.match(content, /^## Source$/m);
      assert.ok(content.endsWith(SENTINEL + '\n'), 'must end with sentinel');
    }),
  },
  {
    name: 'create: missing required field (no learning) → exit 1',
    fn: () => withTmp((dir) => {
      const r = runCli(['--mode', 'create'], {
        topicFile: path.join(dir, 'x.md'),
        name: 'x', description: 'd', originSessionId: 's', created: '2026-05-12',
        sourceSession: 's', sourceDate: '2026-05-12',
        // missing: learning
      });
      assert.strictEqual(r.exitCode, 1);
      assert.match(JSON.parse(r.stdout).error, /missing learning/);
    }),
  },
  {
    name: 'create: file already exists → exit 1',
    fn: () => withTmp((dir) => {
      const topicFile = path.join(dir, 'rh-existing.md');
      fs.writeFileSync(topicFile, 'pre-existing content');
      const r = runCli(['--mode', 'create'], {
        topicFile,
        name: 'x', description: 'd', originSessionId: 's', created: '2026-05-12',
        learning: 'l', sourceSession: 's', sourceDate: '2026-05-12',
      });
      assert.strictEqual(r.exitCode, 1);
      assert.match(JSON.parse(r.stdout).error, /already exists/);
    }),
  },
  {
    name: 'create: omits Decision rule section when empty',
    fn: () => withTmp((dir) => {
      const topicFile = path.join(dir, 'rh-no-rule.md');
      const r = runCli(['--mode', 'create'], {
        topicFile, name: 'n', description: 'd', originSessionId: 's',
        created: '2026-05-12', learning: 'l',
        decisionRule: '',  // empty → section should be omitted
        sourceSession: 's', sourceDate: '2026-05-12',
      });
      assert.strictEqual(r.exitCode, 0, `stderr: ${r.stderr}`);
      const content = fs.readFileSync(topicFile, 'utf-8');
      assert.ok(!content.includes('## Decision rule'),
        'Decision rule section should be omitted when input is empty');
    }),
  },

  // ───────── mode: append-observation ─────────
  {
    name: 'append-observation: missing file → exit 1',
    fn: () => withTmp((dir) => {
      const r = runCli(['--mode', 'append-observation'], {
        topicFile: path.join(dir, 'does-not-exist.md'),
        dateIso: '2026-05-12', sessionShort: 'sess1234', observation: 'note',
      });
      assert.strictEqual(r.exitCode, 1);
      assert.match(JSON.parse(r.stdout).error, /does not exist/);
    }),
  },
  {
    name: 'append-observation: adds row under ## Observations section',
    fn: () => withTmp((dir) => {
      const topicFile = path.join(dir, 'rh-obs.md');
      fs.writeFileSync(topicFile,
        '---\nname: "x"\n---\n\n## Learning\n\nbody\n\n' + SENTINEL + '\n');
      const r = runCli(['--mode', 'append-observation'], {
        topicFile, dateIso: '2026-05-12', sessionShort: 'sess1234',
        observation: 'first observation',
      });
      assert.strictEqual(r.exitCode, 0, `stderr: ${r.stderr}; stdout: ${r.stdout}`);
      const content = fs.readFileSync(topicFile, 'utf-8');
      assert.match(content, /## Observations/, 'should add ## Observations section');
      assert.match(content, /- 2026-05-12 \(session sess1234\): first observation/);
      assert.ok(content.endsWith(SENTINEL + '\n'), 'sentinel must be at EOF after append');
    }),
  },
  {
    name: 'append-observation: appends to existing ## Observations section',
    fn: () => withTmp((dir) => {
      const topicFile = path.join(dir, 'rh-obs2.md');
      fs.writeFileSync(topicFile,
        '---\nname: "x"\n---\n\n## Learning\n\nbody\n\n## Observations\n\n' +
        '- 2026-05-01 (session sessA): first\n' + SENTINEL + '\n');
      const r = runCli(['--mode', 'append-observation'], {
        topicFile, dateIso: '2026-05-12', sessionShort: 'sessB',
        observation: 'second',
      });
      assert.strictEqual(r.exitCode, 0, `stderr: ${r.stderr}`);
      const content = fs.readFileSync(topicFile, 'utf-8');
      assert.match(content, /first/);
      assert.match(content, /second/);
      // exactly one ## Observations section
      assert.strictEqual((content.match(/## Observations/g) || []).length, 1,
        'must not duplicate Observations header');
    }),
  },
  {
    name: 'append-observation: truncates observation longer than 300 chars',
    fn: () => withTmp((dir) => {
      const topicFile = path.join(dir, 'rh-trunc.md');
      fs.writeFileSync(topicFile, '---\nname: x\n---\n\n## Learning\nbody\n\n' + SENTINEL + '\n');
      const longObs = 'x'.repeat(500);
      const r = runCli(['--mode', 'append-observation'], {
        topicFile, dateIso: '2026-05-12', sessionShort: 'sess', observation: longObs,
      });
      assert.strictEqual(r.exitCode, 0);
      const content = fs.readFileSync(topicFile, 'utf-8');
      // 297 chars + …
      assert.ok(content.includes('…'), 'truncation marker (…) must be present');
      // The literal full 500-char string should NOT appear intact
      assert.ok(!content.includes('x'.repeat(301)),
        'should not preserve content past truncation');
    }),
  },

  // ───────── mode: update-sub-index ─────────
  {
    name: 'update-sub-index: missing file → creates header + appends row',
    fn: () => withTmp((dir) => {
      const indexFile = path.join(dir, 'MEMORY.md');
      const r = runCli(['--mode', 'update-sub-index'], {
        indexFile, topic: 'rh-test', name: 'Test topic', lastUpdated: '2026-05-12',
      });
      assert.strictEqual(r.exitCode, 0, `stderr: ${r.stderr}; stdout: ${r.stdout}`);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.action, 'appended');
      const content = fs.readFileSync(indexFile, 'utf-8');
      assert.match(content, /\| topic \| name \| last-updated \|/, 'header row');
      assert.match(content, /\| rh-test \| Test topic \| 2026-05-12 \|/);
      assert.ok(content.endsWith(SENTINEL + '\n'));
    }),
  },
  {
    name: 'update-sub-index: updates existing row when topic key matches',
    fn: () => withTmp((dir) => {
      const indexFile = path.join(dir, 'MEMORY.md');
      fs.writeFileSync(indexFile,
        '# Learnings sub-index\n\n| topic | name | last-updated |\n|---|---|---|\n' +
        '| rh-existing | Old name | 2026-04-01 |\n' + SENTINEL + '\n');
      const r = runCli(['--mode', 'update-sub-index'], {
        indexFile, topic: 'rh-existing', name: 'Updated name', lastUpdated: '2026-05-12',
      });
      assert.strictEqual(r.exitCode, 0);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.action, 'updated');
      const content = fs.readFileSync(indexFile, 'utf-8');
      assert.match(content, /\| rh-existing \| Updated name \| 2026-05-12 \|/);
      assert.ok(!content.includes('Old name'), 'old row should be gone');
      assert.ok(!content.includes('2026-04-01'), 'old date should be gone');
    }),
  },
  {
    name: 'update-sub-index: pipe in name is escaped',
    fn: () => withTmp((dir) => {
      const indexFile = path.join(dir, 'MEMORY.md');
      const r = runCli(['--mode', 'update-sub-index'], {
        indexFile, topic: 'rh-pipe', name: 'name with | pipe', lastUpdated: '2026-05-12',
      });
      assert.strictEqual(r.exitCode, 0);
      const content = fs.readFileSync(indexFile, 'utf-8');
      assert.match(content, /\| name with \\\| pipe \|/, 'pipe must be escaped');
    }),
  },

  // ───────── mode: update-root-index ─────────
  {
    name: 'update-root-index: missing file → exit 1',
    fn: () => withTmp((dir) => {
      const r = runCli(['--mode', 'update-root-index'], {
        indexFile: path.join(dir, 'no.md'), topicCount: 5,
      });
      assert.strictEqual(r.exitCode, 1);
      assert.match(JSON.parse(r.stdout).error, /does not exist/);
    }),
  },
  {
    name: 'update-root-index: updates existing Learnings index line',
    fn: () => withTmp((dir) => {
      const indexFile = path.join(dir, 'MEMORY.md');
      fs.writeFileSync(indexFile,
        '# Root\n\n' +
        '- some unrelated line\n' +
        '- [Learnings index](learnings/MEMORY.md) — 7 topics; capability deltas captured per session\n' +
        '- another line\n');
      const r = runCli(['--mode', 'update-root-index'], {
        indexFile, topicCount: 42,
      });
      assert.strictEqual(r.exitCode, 0, `stderr: ${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.action, 'updated');
      const content = fs.readFileSync(indexFile, 'utf-8');
      assert.match(content, /— 42 topics;/);
      assert.ok(!content.includes('— 7 topics;'), 'old count should be gone');
      // Unrelated lines preserved
      assert.ok(content.includes('some unrelated line'));
      assert.ok(content.includes('another line'));
    }),
  },
  {
    name: 'update-root-index: line absent → absent-not-inserted, no write',
    fn: () => withTmp((dir) => {
      const indexFile = path.join(dir, 'MEMORY.md');
      const original = '# Root\n\n- only this line\n';
      fs.writeFileSync(indexFile, original);
      const r = runCli(['--mode', 'update-root-index'], {
        indexFile, topicCount: 5,
      });
      assert.strictEqual(r.exitCode, 0);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.action, 'absent-not-inserted');
      assert.ok(out.expectedLine.includes('Learnings index'));
      // File should be unchanged
      assert.strictEqual(fs.readFileSync(indexFile, 'utf-8'), original);
    }),
  },
  {
    name: 'update-root-index: missing topicCount → exit 1 (validation)',
    fn: () => withTmp((dir) => {
      const indexFile = path.join(dir, 'MEMORY.md');
      fs.writeFileSync(indexFile, '# x\n');
      const r = runCli(['--mode', 'update-root-index'], { indexFile });
      assert.strictEqual(r.exitCode, 1);
      assert.match(JSON.parse(r.stdout).error, /missing topicCount/);
    }),
  },
];

module.exports = { tests };

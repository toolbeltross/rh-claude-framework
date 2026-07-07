// Unit tests for rh-scribe-table-write.js — atomic, sentinel-aware row
// appender used by rh-scribe-multiscope to write recommendations.md /
// cleanup.md. The sentinel handling is critical: rh-scribe-prefilter.js
// previously had a two-sentinel-accumulation bug; this script's anti-bug
// is its main correctness contract.

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'rh-scribe-table-write.js');
const SENTINEL = '<!-- scribe-done -->';

// rh-scribe-table-write does a best-effort postgres dual-write when the target
// basename maps to a bucket (recommendations.md / cleanup.md / learnings.md).
// These tests use a tmp `recs.md` (no bucket → no shadow today), but force the
// shadow OFF defensively so a future test that targets a real bucket filename
// can't leak rows into the live rh_scribe DB. The md-file/sentinel logic is
// what's under test here; the DB shadow is covered (with cleanup) in
// test-scribe-db.js. Env var wins over oversight.json (see @rh/shared/config).
const NO_DB_ENV = { ...process.env, RH_SCRIBE_DB: '0', RH_CONTEXT_DB: '0' };
const PG = process.env.RH_TEST_PG === '1';

function withTmpFile(seed, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-stw-test-'));
  const target = path.join(dir, 'recs.md');
  if (seed !== undefined) fs.writeFileSync(target, seed, 'utf-8');
  try { return fn({ dir, target }); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function runCli(args, stdinJson) {
  const r = spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8', timeout: 5000, windowsHide: true, env: NO_DB_ENV,
    input: stdinJson !== undefined ? JSON.stringify(stdinJson) : '',
  });
  return { exitCode: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

const tests = [
  {
    name: 'missing --target → exit 1 with stderr error',
    fn: () => {
      const r = runCli([]);
      assert.strictEqual(r.exitCode, 1);
      assert.match(r.stderr, /--target is required/);
    },
  },
  {
    name: 'single row via CLI args: appended + JSON status output',
    fn: () => withTmpFile('# header\n', ({ target }) => {
      const r = runCli([
        '--target', target,
        '--id', 'aaaabbbb', '--session', 'sess1234',
        '--text', 'first row',
      ]);
      assert.strictEqual(r.exitCode, 0, `stderr: ${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.ok, true);
      assert.strictEqual(out.wrote, 1);
      const content = fs.readFileSync(target, 'utf-8');
      assert.match(content, /\| aaaabbbb \| .*\| sess1234 \| first row \| open \|/);
      assert.ok(content.includes(SENTINEL), 'sentinel must be present after write');
    }),
  },
  {
    name: 'JSON-array stdin: writes multiple rows',
    fn: () => withTmpFile('# header\n', ({ target }) => {
      const rows = [
        { id: 'row00001', session: 'sess0001', text: 'one' },
        { id: 'row00002', session: 'sess0002', text: 'two' },
        { id: 'row00003', session: 'sess0003', text: 'three' },
      ];
      const r = runCli(['--target', target], rows);
      assert.strictEqual(r.exitCode, 0, `stderr: ${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.wrote, 3);
      const content = fs.readFileSync(target, 'utf-8');
      assert.ok(content.includes('| row00001 |'));
      assert.ok(content.includes('| row00002 |'));
      assert.ok(content.includes('| row00003 |'));
      // All three rows should appear BEFORE the sentinel
      const idxRow3 = content.indexOf('row00003');
      const idxSentinel = content.indexOf(SENTINEL);
      assert.ok(idxRow3 < idxSentinel, 'last row must be above sentinel');
    }),
  },
  {
    name: 'empty stdin: wrote 0, exit 0, target unchanged',
    fn: () => withTmpFile('# header\n', ({ target }) => {
      const r = runCli(['--target', target]);
      assert.strictEqual(r.exitCode, 0, `stderr: ${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.wrote, 0);
      const content = fs.readFileSync(target, 'utf-8');
      assert.strictEqual(content, '# header\n', 'target should be unchanged');
    }),
  },
  {
    name: 'sentinel anti-bug: TWO existing sentinels get collapsed to ONE at EOF',
    fn: () => withTmpFile(
      '# header\n' +
      SENTINEL + '\n' +
      '| oldrow | 2026-05-01 | s | old | open |\n' +
      SENTINEL + '\n',  // duplicate sentinel — the bug scenario
      ({ target }) => {
        const r = runCli([
          '--target', target,
          '--id', 'newrow01', '--session', 'sess9999',
          '--text', 'new',
        ]);
        assert.strictEqual(r.exitCode, 0, `stderr: ${r.stderr}`);
        const content = fs.readFileSync(target, 'utf-8');
        const sentinelCount = (content.match(new RegExp(SENTINEL.replace(/[!-]/g, '\\$&'), 'g')) || []).length;
        assert.strictEqual(sentinelCount, 1,
          `expected exactly 1 sentinel after dedup; got ${sentinelCount}`);
        // Both old and new rows must be preserved
        assert.ok(content.includes('| oldrow |'), 'old row must survive');
        assert.ok(content.includes('| newrow01 |'), 'new row must appear');
      }
    ),
  },
  {
    name: 'sentinel at non-EOF: stripped + replaced at EOF after new rows',
    fn: () => withTmpFile(
      '# header\n' +
      '| oldrow | 2026-05-01 | s | existing | open |\n' +
      SENTINEL + '\n' +
      '## section after sentinel\n' +
      'free-form note\n',
      ({ target }) => {
        const r = runCli([
          '--target', target,
          '--id', 'midnew01', '--session', 's2',
          '--text', 'mid-file new row',
        ]);
        assert.strictEqual(r.exitCode, 0, `stderr: ${r.stderr}`);
        const content = fs.readFileSync(target, 'utf-8');
        // Sentinel should now be at EOF (last non-empty line) — script normalizes
        const lines = content.split('\n').filter(Boolean);
        assert.strictEqual(lines[lines.length - 1], SENTINEL,
          `sentinel should be the last non-empty line; got ${JSON.stringify(lines.slice(-3))}`);
        // Section content should still be present
        assert.ok(content.includes('## section after sentinel'),
          'free-form content after sentinel must be preserved');
      }
    ),
  },
  {
    name: 'pipe in text is escaped (\\|) so it does not break the table column',
    fn: () => withTmpFile('# header\n', ({ target }) => {
      const r = runCli([
        '--target', target,
        '--id', 'pipe0001', '--session', 's',
        '--text', 'a | b | c',
      ]);
      assert.strictEqual(r.exitCode, 0);
      const content = fs.readFileSync(target, 'utf-8');
      assert.ok(content.includes('a \\| b \\| c'),
        `expected escaped pipes; content tail: ${content.slice(-200)}`);
    }),
  },
  {
    name: 'newline in text is flattened to space (single-row schema)',
    fn: () => withTmpFile('# header\n', ({ target }) => {
      const r = runCli([
        '--target', target,
        '--id', 'nl000001', '--session', 's',
        '--text', 'line1\nline2',
      ]);
      assert.strictEqual(r.exitCode, 0);
      const content = fs.readFileSync(target, 'utf-8');
      assert.ok(content.includes('line1 line2'),
        `expected newline flattened; content tail: ${content.slice(-200)}`);
    }),
  },
  {
    name: 'session truncated to 8 chars',
    fn: () => withTmpFile('# header\n', ({ target }) => {
      const r = runCli([
        '--target', target,
        '--id', 'sesstrun', '--session', 'abcdefghijklmnop',  // 16 chars
        '--text', 'x',
      ]);
      assert.strictEqual(r.exitCode, 0);
      const content = fs.readFileSync(target, 'utf-8');
      assert.match(content, /\| abcdefgh \|/, 'session must be truncated to first 8 chars');
      assert.ok(!content.includes('ijklmnop'), 'characters beyond 8th must NOT appear');
    }),
  },
  {
    name: 'row missing required field (no session) → exit 1',
    fn: () => withTmpFile('# header\n', ({ target }) => {
      const r = runCli(['--target', target], [{ id: 'x', text: 'no session' }]);
      assert.strictEqual(r.exitCode, 1);
      assert.match(r.stderr, /needs id, text, session/);
    }),
  },
  {
    name: '--dry-run: prints would-write JSON, does NOT touch target',
    fn: () => withTmpFile('# original\n', ({ target }) => {
      const r = runCli([
        '--target', target, '--dry-run',
        '--id', 'dry00001', '--session', 's', '--text', 'should not land',
      ]);
      assert.strictEqual(r.exitCode, 0);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.dryRun, true);
      assert.strictEqual(out.wrote, 0);
      assert.ok(Array.isArray(out.wouldWriteLines), 'should report wouldWriteLines');
      const content = fs.readFileSync(target, 'utf-8');
      assert.strictEqual(content, '# original\n', 'dry-run must not mutate target');
    }),
  },
  {
    name: 'target file does not exist: creates it with sentinel',
    fn: () => withTmpFile(undefined, ({ target }) => {
      const r = runCli([
        '--target', target,
        '--id', 'new00001', '--session', 's', '--text', 'first ever row',
      ]);
      assert.strictEqual(r.exitCode, 0, `stderr: ${r.stderr}`);
      assert.ok(fs.existsSync(target), 'target should be created');
      const content = fs.readFileSync(target, 'utf-8');
      assert.ok(content.includes('| new00001 |'));
      assert.ok(content.includes(SENTINEL));
    }),
  },
  {
    name: 'invalid stdin JSON: exit 1 with descriptive error',
    fn: () => withTmpFile('', ({ target }) => {
      const r = spawnSync('node', [SCRIPT, '--target', target], {
        encoding: 'utf8', timeout: 5000, windowsHide: true, env: NO_DB_ENV,
        input: 'not json at all',
      });
      assert.strictEqual(r.status, 1);
      assert.match(r.stderr, /stdin must be JSON array/);
    }),
  },
  {
    name: 'stdin non-array JSON: exit 1',
    fn: () => withTmpFile('', ({ target }) => {
      const r = runCli(['--target', target], { not: 'an array' });
      assert.strictEqual(r.exitCode, 1);
      assert.match(r.stderr, /must be an array/);
    }),
  },
  {
    // Outer-seam: invoke the CLI with contextDb ON against a real bucket
    // filename and confirm the 3rd write lands through the privacy gate.
    name: PG ? 'PG: contextDb on — clean cleanup row mirrors to ctx_memory_artifact via the gate' : 'PG: ctx wiring skipped (RH_TEST_PG!=1)',
    fn: () => {
      if (!PG) return;
      const ctx = require(path.join(__dirname, '..', 'scripts', 'lib', 'context-db'));
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-stw-ctx-'));
      const target = path.join(dir, 'cleanup.md');       // basename → bucket 'cleanup'
      const canonical = ctx.canonicalSourceFile(target);
      const rid = 'ctxwire' + Date.now().toString(16).slice(-6);
      try {
        const r = spawnSync('node', [SCRIPT, '--target', target, '--id', rid, '--session', 'sesswire', '--text', 'benign cleanup note'], {
          encoding: 'utf8', timeout: 8000, windowsHide: true,
          env: { ...process.env, RH_SCRIBE_DB: '0', RH_CONTEXT_DB: '1' },
        });
        assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
        const out = JSON.parse(r.stdout);
        assert.strictEqual(out.ctxShadow, 'written', `expected ctxShadow written; got ${out.ctxShadow}; stderr ${r.stderr}`);
        const art = ctx.runSql(`SELECT count(*) FROM ctx_memory_artifact WHERE bucket='cleanup' AND row_id='${rid}' AND source_file='${canonical}';`);
        assert.strictEqual(art.stdout, '1', 'artifact mirrored under the canonical source_file');
        const disp = ctx.runSql(`SELECT privacy_disposition FROM ctx_ingest_source WHERE canonical_path='${canonical}';`);
        assert.strictEqual(disp.stdout, 'clean', 'source classified clean (scribe_md, non-private, PII-clean)');
        const dw = ctx.runSql(`SELECT count(*) FROM ctx_dualwrite_log WHERE entity_natural_key='cleanup|${canonical}|${rid}' AND result='ok';`);
        assert.strictEqual(dw.stdout, '1', 'dualwrite audit row recorded ok');
      } finally {
        ctx.runSql(`DELETE FROM ctx_memory_artifact WHERE row_id='${rid}';`);
        ctx.runSql(`DELETE FROM ctx_ingest_source WHERE canonical_path='${canonical}';`);
        ctx.runSql(`DELETE FROM ctx_dualwrite_log WHERE entity_natural_key='cleanup|${canonical}|${rid}';`);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
];

module.exports = { tests };

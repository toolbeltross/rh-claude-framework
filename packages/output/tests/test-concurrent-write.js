// Concurrency stress test for output writers.
//
// Spawns N parallel processes via shell (bash & ... wait) so all writers
// truly race on the lock. Each appends a unique marker line. After all
// processes complete, asserts:
//   1. The file has exactly N marker lines (no writes lost)
//   2. No marker line appears truncated or interleaved (no corruption)
//   3. The original header survives
//
// This guards the cross-process lock contract for state-md / render-html /
// daily-regen marker writes added in the Phase 2 reorg.

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const N_WRITERS = 16;

function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-output-concurrent-'));
  try { return fn(dir); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const tests = [
  {
    name: `withLock survives ${N_WRITERS}-way parallel append without loss or corruption`,
    fn: () => withTmpDir((dir) => {
      const target = path.join(dir, 'target.md');
      fs.writeFileSync(target, '# header\n', 'utf8');

      const workerScript = path.join(__dirname, 'helpers', 'concurrent-writer.js');
      assert.ok(fs.existsSync(workerScript), `helper not found at ${workerScript}`);

      // Write a shell script to a temp file and invoke bash explicitly.
      // execSync('bash -c ...') gets intercepted by cmd.exe on Windows even
      // when bash is on PATH; spawning bash with a -c arg via spawnSync
      // bypasses cmd parsing.
      const node = process.execPath.replace(/\\/g, '/');
      const wsh = workerScript.replace(/\\/g, '/');
      const tgt = target.replace(/\\/g, '/');
      const scriptPath = path.join(dir, 'spawn-all.sh');
      const lines = ['#!/bin/bash'];
      for (let i = 0; i < N_WRITERS; i++) {
        lines.push(`"${node}" "${wsh}" "${tgt}" ${i} &`);
      }
      lines.push('wait');
      fs.writeFileSync(scriptPath, lines.join('\n'), 'utf8');

      const result = spawnSync('bash', [scriptPath], { stdio: 'pipe', timeout: 30000 });
      if (result.status !== 0) {
        throw new Error(`bash spawn failed (status ${result.status}): ${result.stderr?.toString() || ''}`);
      }

      const content = fs.readFileSync(target, 'utf8');
      const markerLines = content.split('\n').filter(l => l.startsWith('worker-'));
      assert.strictEqual(markerLines.length, N_WRITERS,
        `expected ${N_WRITERS} marker lines, got ${markerLines.length}`);

      const seen = new Set();
      for (const line of markerLines) {
        const m = line.match(/^worker-(\d+) done$/);
        assert.ok(m, `corrupted line: ${JSON.stringify(line)}`);
        const id = parseInt(m[1], 10);
        assert.ok(!seen.has(id), `duplicate writer id ${id}`);
        seen.add(id);
      }

      assert.ok(content.startsWith('# header\n'), 'header was clobbered');
    }),
  },
];

module.exports = { tests };

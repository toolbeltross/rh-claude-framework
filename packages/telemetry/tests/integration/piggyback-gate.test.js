/**
 * Integration (outer seam) test for the toolPiggyback gate.
 *
 * Drives the REAL scripts/hook-forwarder.js as a child process (the actual
 * PostToolUse entry point) against a local capture server on an ephemeral
 * port (RH_TELEMETRY_PORT). Asserts the wiring — not just the pure predicate:
 *
 *   - Interactive tool event (no agent fields)        → posts /api/status (toolPiggyback)
 *   - Agent tool event (agent_type set, agent_id null) → does NOT post /api/status
 *
 * Both still post /api/hooks (the tool event itself). The second case is the
 * 2026-06-19 regression: rh-daily-guidance `--agent` workers each minted a
 * phantom top-level session tab. agent_type is type-without-id, so the gate
 * must key on agent_type (not just agent_id).
 *
 * HOME is redirected to a tmp dir so the spawned forwarder never touches the
 * real ~/.claude (idle marker etc.), per the test isolation rule.
 */
import assert from 'assert';
import http from 'http';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { test, summary, afterAll } from '../helpers/test-harness.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = join(__dirname, '..', '..');                 // packages/telemetry
const FORWARDER = join(PKG, 'scripts', 'hook-forwarder.js');
const TRANSCRIPT = join(PKG, 'tests', 'fixtures', 'transcripts', 'sample.jsonl');

console.log('piggyback-gate integration (forwarder outer seam):\n');

const TMP_HOME = mkdtempSync(join(tmpdir(), 'pgcheck-'));
const reqs = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(body); } catch {}
    reqs.push({ url: req.url, source: parsed._source });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
});
const port = await new Promise((resolve) =>
  server.listen(0, '127.0.0.1', () => resolve(server.address().port)),
);
afterAll(() => new Promise((r) => server.close(r)));
afterAll(() => { try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch {} });

function runForwarder(payload) {
  const before = reqs.length;
  return new Promise((resolve) => {
    const child = spawn('node', [FORWARDER, 'tool', payload.tool_name, payload.session_id, 'post_tool_use'], {
      env: { ...process.env, RH_TELEMETRY_PORT: String(port), HOME: TMP_HOME, USERPROFILE: TMP_HOME },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.on('close', async () => {
      await new Promise((r) => setTimeout(r, 250)); // let any in-flight POST land
      resolve(reqs.slice(before));
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

const base = { tool_name: 'WebFetch', session_id: 'sess-seam', cwd: 'C:/x', transcript_path: TRANSCRIPT };

test('interactive tool event posts the toolPiggyback status (desktop live tab)', async () => {
  const r = await runForwarder({ ...base });
  assert.ok(r.some((x) => x.url === '/api/hooks'), 'tool event should be forwarded');
  assert.ok(
    r.some((x) => x.url === '/api/status' && x.source === 'toolPiggyback'),
    'interactive session should post the piggyback status',
  );
});

test('agent tool event (agent_type set) does NOT post status — no phantom session tab', async () => {
  const r = await runForwarder({ ...base, agent_type: 'rh-daily-guidance', agent_id: null });
  assert.ok(r.some((x) => x.url === '/api/hooks'), 'tool event should still be forwarded');
  assert.ok(
    !r.some((x) => x.url === '/api/status'),
    'agent tool event must NOT post a status (gated)',
  );
});

summary();

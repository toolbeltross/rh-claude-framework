#!/usr/bin/env node
// statusline-wrapped.js — wraps the user's statusLine script while forwarding
// parsed stdin to the telemetry dashboard's /api/status endpoint.

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const { config } = require('./lib/config');

const ORIGINAL = path.join(config.scriptsDir, 'rh-statusline.js');
const POST_TIMEOUT = 500;

function readStdinBuffer() {
  return new Promise((resolve) => {
    const chunks = [];
    let resolved = false;
    const done = () => { if (resolved) return; resolved = true; resolve(Buffer.concat(chunks).toString('utf-8')); };
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', done);
    process.stdin.on('error', done);
    setTimeout(done, 2000);
  });
}

function postStatus(payload) {
  return new Promise((resolve) => {
    try {
      const body = JSON.stringify(payload);
      const req = http.request(
        { hostname: 'localhost', port: config.telemetryPort, path: '/api/status', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: POST_TIMEOUT },
        (res) => { res.resume(); resolve(); }
      );
      req.on('error', () => resolve());
      req.on('timeout', () => { try { req.destroy(); } catch {} resolve(); });
      req.write(body);
      req.end();
    } catch { resolve(); }
  });
}

(async () => {
  const raw = await readStdinBuffer();

  try {
    const parsed = JSON.parse(raw);
    postStatus({ ...parsed, _source: 'statusLineWrapped' });
  } catch {}

  try {
    const child = spawn('node', [ORIGINAL], { stdio: ['pipe', 'inherit', 'inherit'] });
    child.on('error', () => process.exit(0));
    child.on('exit', (code) => process.exit(code || 0));
    child.stdin.on('error', () => {});
    child.stdin.write(raw);
    child.stdin.end();
  } catch { process.exit(0); }
})();

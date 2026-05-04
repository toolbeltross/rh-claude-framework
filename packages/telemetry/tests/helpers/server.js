/**
 * Spawn a test telemetry server in a child process with isolated HOME.
 *
 * The server reads RH_TELEMETRY_PORT and HOME from env. Setting HOME to
 * a tmp dir means all `~/.claude/*` paths in server/config.js auto-redirect
 * into the tmp area — full isolation from the developer's live setup.
 *
 * Usage:
 *   const server = await startTestServer({ tmpHome });
 *   await fetch(`${server.baseUrl}/api/snapshot`);
 *   await server.stop();
 */
import { spawn } from 'child_process';
import { dirname, resolve, join } from 'path';
import { fileURLToPath } from 'url';
import { findFreePort } from './ports.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..');
const SERVER_ENTRY = join(PROJECT_ROOT, 'server', 'index.js');

const STARTUP_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 100;

/**
 * @param {object} opts
 * @param {string} opts.tmpHome - absolute path to use as HOME (must contain .claude/settings.json)
 * @param {number} [opts.port] - port to use (random free if omitted)
 * @param {object} [opts.extraEnv] - additional env vars (e.g. RH_TELEMETRY_TEST_MODE=1)
 * @param {boolean} [opts.captureLogs] - if true, capture stdout/stderr to .logs[]
 * @returns {Promise<{proc, baseUrl, wsUrl, port, stop, logs}>}
 */
export async function startTestServer({ tmpHome, port, extraEnv = {}, captureLogs = false } = {}) {
  if (!tmpHome) throw new Error('startTestServer: tmpHome required');
  const finalPort = port || (await findFreePort());

  const env = {
    ...process.env,
    HOME: tmpHome,
    USERPROFILE: tmpHome, // Windows fallback in config.js
    RH_TELEMETRY_PORT: String(finalPort),
    ...extraEnv,
  };

  const logs = [];
  const proc = spawn('node', [SERVER_ENTRY], {
    cwd: PROJECT_ROOT,
    env,
    stdio: captureLogs ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'ignore', 'pipe'],
  });

  if (proc.stdout) {
    proc.stdout.on('data', (chunk) => {
      const s = chunk.toString();
      if (captureLogs) logs.push(s);
    });
  }
  if (proc.stderr) {
    proc.stderr.on('data', (chunk) => {
      const s = chunk.toString();
      logs.push(s);
    });
  }

  const baseUrl = `http://127.0.0.1:${finalPort}`;
  const wsUrl = `ws://127.0.0.1:${finalPort}/ws`;

  // Poll /api/health until ready or timeout
  const start = Date.now();
  let ready = false;
  while (Date.now() - start < STARTUP_TIMEOUT_MS) {
    try {
      const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(500) });
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  if (!ready) {
    proc.kill('SIGKILL');
    throw new Error(
      `Test server did not become ready within ${STARTUP_TIMEOUT_MS}ms on port ${finalPort}.\n` +
      `Logs:\n${logs.join('')}`
    );
  }

  return {
    proc,
    baseUrl,
    wsUrl,
    port: finalPort,
    logs,
    async stop() {
      return new Promise((resolve) => {
        if (proc.exitCode !== null) return resolve();
        const killTimer = setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch {}
          resolve();
        }, 2000);
        proc.once('exit', () => {
          clearTimeout(killTimer);
          resolve();
        });
        try { proc.kill('SIGTERM'); } catch {
          clearTimeout(killTimer);
          resolve();
        }
      });
    },
  };
}

/** Convenience helper for fetch + JSON. */
export async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json();
}

/** Convenience helper for POST + JSON. */
export async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${url} → ${res.status}`);
  return res.json().catch(() => ({}));
}

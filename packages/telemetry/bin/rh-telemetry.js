#!/usr/bin/env node
// Unified CLI entry point for rh-telemetry.
// Works whether globally installed (npm i -g) or locally cloned.

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import net from 'net';

import { PORT } from '../server/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const args = process.argv.slice(2);
const command = args[0] || 'summary';

function run(script, scriptArgs = [], options = {}) {
  const child = spawn('node', [join(ROOT, script), ...scriptArgs], {
    cwd: ROOT,
    stdio: options.stdio || 'inherit',
    detached: options.detached || false,
    ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
  });
  if (options.detached) {
    child.unref();
    return child;
  }
  child.on('exit', (code) => process.exit(code || 0));
  return child;
}

function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(true));
    server.once('listening', () => {
      server.close();
      resolve(false);
    });
    server.listen(port);
  });
}

async function checkHealth() {
  try {
    const res = await fetch(`http://localhost:${PORT}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      const data = await res.json();
      console.log(`Telemetry server is running on port ${PORT}`);
      console.log(`  Uptime: ${Math.floor(data.uptime)}s`);
      console.log(`  Dashboard: http://localhost:${PORT}`);
      return true;
    }
  } catch {
    // not running
  }
  console.log(`Telemetry server is not running on port ${PORT}.`);
  return false;
}

function printUsage() {
  console.log(`
  rh-telemetry — Real-time monitoring for Claude Code sessions

  Usage:
    rh-telemetry setup                Configure hooks + install skills
    rh-telemetry repair-statusline    Classify + repair statusLine config
    rh-telemetry start                Start the server (foreground)
    rh-telemetry start --bg           Start the server (background)
    rh-telemetry dev                  Start server + Vite dev server
    rh-telemetry status               Check if the server is running
    rh-telemetry digest               Failure digest (last 24h, stdout)
    rh-telemetry digest --append  Append digest to ~/.claude/telemetry-supervisory-log.md
    rh-telemetry digest --hours 48  Custom time window
    rh-telemetry hook-perf          Hook latency stats (per-hook p50/p95/max)
    rh-telemetry hook-perf slowest  Top 10 slowest hook invocations

  Telemetry queries (passthrough to telemetry-cli):
    rh-telemetry              Session summary (default)
    rh-telemetry summary      Session summary
    rh-telemetry sessions     All sessions by cost
    rh-telemetry costs        Cost breakdown by model
    rh-telemetry context      Context window details
    rh-telemetry activity     Daily activity stats
    rh-telemetry session <n>  Details for project <n>

  Options:
    --help, -h    Show this help message
`);
}

// --- Command dispatch ---

switch (command) {
  case '--help':
  case '-h':
  case 'help':
    printUsage();
    break;

  case 'setup': {
    // Run setup-hooks → install-skills → install-git-hooks sequentially
    const hooks = spawn('node', [join(ROOT, 'scripts', 'setup-hooks.js')], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    hooks.on('exit', (code) => {
      if (code !== 0) process.exit(code || 1);
      const skills = spawn('node', [join(ROOT, 'scripts', 'install-skills.js')], {
        cwd: ROOT,
        stdio: 'inherit',
      });
      skills.on('exit', (c) => {
        if (c !== 0) process.exit(c || 1);
        const gitHooks = spawn('node', [join(ROOT, 'scripts', 'install-git-hooks.js')], {
          cwd: ROOT,
          stdio: 'inherit',
        });
        gitHooks.on('exit', (g) => process.exit(g || 0));
      });
    });
    break;
  }

  case 'repair-statusline': {
    run('scripts/repair-statusline.js', args.slice(1));
    break;
  }

  case 'install-git-hooks': {
    run('scripts/install-git-hooks.js', args.slice(1));
    break;
  }

  case 'start': {
    // Pre-start classification (Layer A summary log so users see the state
    // before the server comes up)
    try {
      const { classifyStatusLineFromFile } = await import('../scripts/statusline-classifier.js');
      const { CLAUDE_SETTINGS_PATH } = await import('../server/config.js');
      const result = classifyStatusLineFromFile(CLAUDE_SETTINGS_PATH);
      const healthy = result.class === 'telemetry' || result.class === 'telemetry-wrapper';
      const tag = healthy ? `healthy (${result.class})` : `DEGRADED (${result.class})`;
      console.log(`[statusline] ${tag}${result.reason ? ` — ${result.reason}` : ''}`);
      if (!healthy) {
        console.log(`[statusline] run 'rh-telemetry repair-statusline' to fix`);
      }
    } catch (err) {
      console.error(`[statusline] pre-start classification failed: ${err.message}`);
    }

    if (args.includes('--bg') || args.includes('-d')) {
      run('scripts/start-bg.js');
    } else {
      run('server/index.js');
    }
    break;
  }

  case 'dev': {
    // concurrently runs server + vite — needs devDependencies
    run('node_modules/.bin/concurrently', ['"node server/index.js"', '"npx vite"']);
    break;
  }

  case 'status': {
    const running = await checkHealth();
    process.exit(running ? 0 : 1);
    break;
  }

  case 'digest': {
    // Failure digest — summarize recent failures
    const digestArgs = args.slice(1);
    run('scripts/failure-digest.js', digestArgs);
    break;
  }

  case 'hook-perf': {
    run('scripts/hook-perf-cli.js', args.slice(1));
    break;
  }

  // Telemetry CLI passthrough commands
  case 'summary':
  case 'sessions':
  case 'costs':
  case 'cost':
  case 'context':
  case 'activity':
  case 'live':
  case 'session':
    run('scripts/telemetry-cli.js', args);
    break;

  default:
    // Unknown command — try as session name lookup via CLI
    run('scripts/telemetry-cli.js', args);
    break;
}
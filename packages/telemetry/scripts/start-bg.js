import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import net from 'net';
import { PORT } from '../server/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

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

async function main() {
  const inUse = await isPortInUse(PORT);
  if (inUse) {
    console.log(`Telemetry server already running on port ${PORT}.`);
    process.exit(0);
  }

  const child = spawn('node', ['server/index.js'], {
    cwd: ROOT,
    stdio: 'ignore',
    detached: true,
  });

  child.unref();
  console.log(`Telemetry server started in background (PID ${child.pid}, port ${PORT}).`);
}

main().catch(console.error);
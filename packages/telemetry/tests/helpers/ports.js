/**
 * Find a free TCP port. Used to spawn test servers without colliding with
 * the developer's live :7890 server or other tests running in parallel.
 */
import { createServer } from 'net';

export function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

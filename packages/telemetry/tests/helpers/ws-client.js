/**
 * Lightweight WebSocket test client. Records all incoming frames and offers
 * a `waitFor(predicate)` to await a specific frame.
 *
 * Uses the 'ws' package which is already a runtime dep.
 */
import WebSocket from 'ws';

/**
 * @param {string} wsUrl - e.g. ws://127.0.0.1:1234/ws
 * @returns {Promise<{ws, frames, waitFor, close}>}
 */
export async function openTestWs(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const frames = [];
  const listeners = [];

  ws.on('message', (data) => {
    let parsed;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      parsed = { _raw: data.toString() };
    }
    frames.push(parsed);
    // Fire any waitFor predicates that now match
    for (let i = listeners.length - 1; i >= 0; i--) {
      const l = listeners[i];
      if (l.predicate(parsed)) {
        listeners.splice(i, 1);
        clearTimeout(l.timer);
        l.resolve(parsed);
      }
    }
  });

  // Wait for open
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS open timeout')), 3000);
    ws.once('open', () => { clearTimeout(timer); resolve(); });
    ws.once('error', (err) => { clearTimeout(timer); reject(err); });
  });

  return {
    ws,
    frames,
    /**
     * Wait for a frame matching the predicate. Resolves with the frame.
     * Rejects on timeout (default 2000ms).
     */
    waitFor(predicate, timeoutMs = 2000) {
      // Check existing frames first
      for (const frame of frames) {
        if (predicate(frame)) return Promise.resolve(frame);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = listeners.findIndex((l) => l.timer === timer);
          if (idx >= 0) listeners.splice(idx, 1);
          reject(new Error(`WS waitFor timeout after ${timeoutMs}ms (received ${frames.length} frame(s): ${frames.map(f => f.type).join(', ')})`));
        }, timeoutMs);
        listeners.push({ predicate, resolve, timer });
      });
    },
    close() {
      return new Promise((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) return resolve();
        ws.once('close', () => resolve());
        try { ws.close(); } catch { resolve(); }
      });
    },
  };
}

import { useEffect, useState } from 'react';

/**
 * Subscribe to /api/sessions (per-session detail from the live aggregator).
 * Refetches (debounced) on WS `aggregatesUpdated` — the sessions list derives
 * from the same store, so that frame is the change signal.
 *
 * Returns { data, loading, error, refresh }.
 */
export function useSessions() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function refresh() {
    try {
      const res = await fetch('/api/sessions');
      if (!res.ok) throw new Error(`GET /api/sessions → ${res.status}`);
      setData(await res.json());
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();

    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${wsProto}//${window.location.host}/ws`);
    let debounce = null;
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'aggregatesUpdated') {
          clearTimeout(debounce);
          debounce = setTimeout(refresh, 1000);
        }
      } catch {
        // ignore non-JSON frames
      }
    });

    return () => {
      clearTimeout(debounce);
      ws.close();
    };
  }, []);

  return { data, loading, error, refresh };
}

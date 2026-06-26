import { useEffect, useState } from 'react';

/**
 * Subscribe to /api/aggregates + WS aggregatesUpdated event.
 *
 * Returns { aggregates, loading, error, lastUpdated, refresh }.
 */
export function useAggregates() {
  const [aggregates, setAggregates] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  async function refresh() {
    try {
      const res = await fetch('/api/aggregates');
      if (!res.ok) throw new Error(`GET /api/aggregates → ${res.status}`);
      const data = await res.json();
      setAggregates(data);
      setLastUpdated(Date.now());
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();

    // WS subscribe — same-origin /ws (Vite dev proxies, prod serves on same port)
    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${wsProto}//${window.location.host}/ws`);

    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'aggregatesUpdated' && msg.data) {
          setAggregates(msg.data);
          setLastUpdated(Date.now());
        }
      } catch {
        // ignore non-JSON frames
      }
    });

    return () => ws.close();
  }, []);

  return { aggregates, loading, error, lastUpdated, refresh };
}

import { useEffect, useState } from 'react';

/**
 * Subscribe to /api/subagents (cross-session subagent aggregation).
 * Refetches (debounced) on WS `subagentsAggUpdated`.
 *
 * Returns { data, loading, error, refresh }.
 */
export function useSubagents() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function refresh() {
    try {
      const res = await fetch('/api/subagents');
      if (!res.ok) throw new Error(`GET /api/subagents → ${res.status}`);
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
        if (msg.type === 'subagentsAggUpdated') {
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

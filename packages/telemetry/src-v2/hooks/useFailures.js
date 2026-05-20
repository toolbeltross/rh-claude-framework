import { useEffect, useState } from 'react';

/**
 * Subscribe to failure history + patterns + top-cost endpoints.
 * Also pushes incremental WS failureEvent into the local list.
 *
 * Returns { failures, patterns, topCost, loading, error, refresh }.
 */
export function useFailures({ sinceMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
  const [failures, setFailures] = useState([]);
  const [patterns, setPatterns] = useState(null);
  const [topCost, setTopCost] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function refresh() {
    try {
      const since = Date.now() - sinceMs;
      const [fRes, pRes, tcRes] = await Promise.all([
        fetch(`/api/failures?since=${since}&limit=500`),
        fetch('/api/failures/patterns'),
        fetch(`/api/failures/top-cost?n=10&since=${since}`),
      ]);
      if (!fRes.ok) throw new Error(`/api/failures → ${fRes.status}`);
      if (!pRes.ok) throw new Error(`/api/failures/patterns → ${pRes.status}`);
      if (!tcRes.ok) throw new Error(`/api/failures/top-cost → ${tcRes.status}`);
      setFailures(await fRes.json());
      setPatterns(await pRes.json());
      setTopCost(await tcRes.json());
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
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'failureEvent' && msg.data) {
          setFailures((prev) => [msg.data, ...prev].slice(0, 500));
        }
      } catch {}
    });

    return () => ws.close();
  }, [sinceMs]);

  return { failures, patterns, topCost, loading, error, refresh };
}

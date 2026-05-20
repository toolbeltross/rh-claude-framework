import { useEffect, useState } from 'react';

/**
 * Subscribe to /api/oversight/events?days=N.
 * Returns { data, loading, error, refresh }.
 */
export function useOversight(days = 7) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function refresh() {
    try {
      const res = await fetch(`/api/oversight/events?days=${days}`);
      if (!res.ok) throw new Error(`/api/oversight/events → ${res.status}`);
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
    // Poll every 30s — oversight-events.jsonl is append-only and we don't
    // (yet) have a WS push for it. TODO: add chokidar + WS frame per
    // Phase 0.6 recommendation.
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, [days]);

  return { data, loading, error, refresh };
}

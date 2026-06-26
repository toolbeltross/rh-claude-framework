import { useEffect, useState } from 'react';

/**
 * Subscribe to /api/oversight/events?days=N.
 *
 * Real-time path: WS `oversightEvent` frames (pushed by the server's
 * chokidar watcher on oversight-events.jsonl) trigger a debounced refetch.
 * The 30s poll is kept as fallback — both paths stay live per the project's
 * ADDITIVE ONLY / real-time-first rules.
 *
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
    // Fallback poll — kept alongside the WS push (ADDITIVE)
    const id = setInterval(refresh, 30_000);

    // WS push: refetch (debounced) whenever the server sees new events
    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${wsProto}//${window.location.host}/ws`);
    let debounce = null;
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'oversightEvent') {
          clearTimeout(debounce);
          debounce = setTimeout(refresh, 500);
        }
      } catch {
        // ignore non-JSON frames
      }
    });

    return () => {
      clearInterval(id);
      clearTimeout(debounce);
      ws.close();
    };
  }, [days]);

  return { data, loading, error, refresh };
}

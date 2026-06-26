import { useEffect, useState } from 'react';

/**
 * Map of transcript sessionId → Claude Code Desktop session metadata
 * ({ title, prNumber, prState, ... }) from GET /api/ccd-sessions.
 * Empty object on machines without the Desktop app — callers fall back to
 * their existing labels. Refreshes every 60s (titles rarely change).
 */
export function useCcdTitles() {
  const [titles, setTitles] = useState({});

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const res = await fetch('/api/ccd-sessions');
        if (!res.ok) return;
        const data = await res.json();
        if (alive && data?.byCliId) setTitles(data.byCliId);
      } catch {
        // best-effort — keep last known map
      }
    }
    load();
    const id = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return titles;
}

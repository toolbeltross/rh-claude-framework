/** Compact number formatting (1234 → 1.2K, 1234567 → 1.2M) */
export function formatN(n) {
  if (n == null || isNaN(n)) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

/** USD cost formatter — styleguide §13: ≥ $0.01 two decimals, below four */
export function formatUsd(n) {
  if (n == null || isNaN(n)) return '—';
  if (n >= 1000) return `$${n.toFixed(0)}`;
  if (n >= 0.01) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

/** ISO timestamp → YYYY-MM-DD */
export function isoDate(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toISOString().slice(0, 10);
  } catch {
    return '—';
  }
}

/** Relative time: "3s ago", "2m ago", "1h ago" */
export function relativeTime(ts) {
  if (!ts) return '—';
  const now = Date.now();
  const then = typeof ts === 'number' ? ts : new Date(ts).getTime();
  const diff = now - then;
  if (diff < 1000) return 'just now';
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

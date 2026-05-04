import InfoIcon, { Legend } from './InfoIcon';

export default function PerformanceMetrics({ session }) {
  if (!session?.performance) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-2">
        <span className="text-xs text-gray-400">
          PERFORMANCE: No metrics available
        </span>
      </div>
    );
  }

  const perf = session.performance;

  const metrics = [
    { label: 'FPS', value: session.fps?.toFixed(2) || '—', color: 'text-green', tooltip: 'Frames per second — CLI render speed, higher is smoother' },
    { label: 'Frames', value: perf.frame_duration_ms_count?.toLocaleString() || '—', tooltip: 'Total number of frames rendered during the session' },
    { label: 'p50', value: `${perf.frame_duration_ms_p50?.toFixed(1)}ms`, color: 'text-cyan', tooltip: 'Median frame duration — 50% of frames render faster than this' },
    { label: 'p95', value: `${perf.frame_duration_ms_p95?.toFixed(1)}ms`, color: 'text-amber', tooltip: '95th percentile — only 5% of frames take longer than this' },
    { label: 'p99', value: `${perf.frame_duration_ms_p99?.toFixed(1)}ms`, color: 'text-red', tooltip: '99th percentile (tail latency) — worst-case frame times' },
    { label: 'Range', value: `${perf.frame_duration_ms_min?.toFixed(1)}–${perf.frame_duration_ms_max?.toFixed(1)}ms`, tooltip: 'Min–Max frame duration range (fastest to slowest frame)' },
  ];

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-2">
      <div className="flex items-center gap-2.5 flex-wrap">
        <span className="text-xs font-semibold uppercase tracking-wider text-gray-400 inline-flex items-center gap-1.5 shrink-0" title="CLI rendering performance — frame timing metrics from the Claude Code terminal UI">
          Performance <InfoIcon>
              <div className="space-y-1.5">
                <p>CLI rendering metrics. A 'frame' is one screen redraw of the terminal UI. Higher FPS = smoother.</p>
                <div className="flex flex-wrap gap-x-1 gap-y-0.5"><Legend color="bg-green" label="good" /><Legend color="bg-cyan" label="baseline" /><Legend color="bg-amber" label="elevated" /><Legend color="bg-red" label="high latency" /></div>
              </div>
            </InfoIcon>
        </span>
        {metrics.map((m) => (
          <div key={m.label} className="flex items-center gap-1" title={m.tooltip}>
            <span className="text-[10px] uppercase text-gray-400">
              {m.label}
            </span>
            <span className={`text-xs font-mono font-semibold ${m.color || 'text-gray-300'}`}>
              {m.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
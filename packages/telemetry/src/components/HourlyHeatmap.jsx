import { VIZ } from '../lib/style-tokens';

export default function HourlyHeatmap({ stats }) {
  if (!stats?.hourCounts) {
    return (
      <Panel title="Hourly Activity" tooltip="Session distribution by hour of day — darker = more sessions at that hour">
        <p className="text-gray-400 text-sm">No data</p>
      </Panel>
    );
  }

  const hours = Array.from({ length: 24 }, (_, i) => i);
  const counts = stats.hourCounts;
  const maxCount = Math.max(...Object.values(counts), 1);

  function getIntensity(count) {
    if (!count) return 0;
    return Math.max(0.15, count / maxCount);
  }

  function formatHour(h) {
    if (h === 0) return '12a';
    if (h < 12) return `${h}a`;
    if (h === 12) return '12p';
    return `${h - 12}p`;
  }

  return (
    <Panel title="Hourly Activity" tooltip="Session distribution by hour of day — darker = more sessions at that hour">
      <div className="flex flex-col gap-2">
        <div className="flex gap-1.5">
          {hours.map((h) => {
            const count = counts[String(h)] || 0;
            const intensity = getIntensity(count);
            return (
              <div
                key={h}
                className="flex-1 flex flex-col items-center gap-1"
              >
                <div
                  className="w-full h-10 rounded-sm transition-all"
                  style={{
                    backgroundColor:
                      count > 0
                        ? `${VIZ.activity.rgba(intensity)}`
                        : 'rgba(42, 42, 56, 0.5)',
                  }}
                  title={`${formatHour(h)}: ${count} sessions`}
                />
                <span className="text-[9px] text-gray-400">
                  {h % 3 === 0 ? formatHour(h) : ''}
                </span>
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-2 text-[10px] text-gray-400 mt-1">
          <span>Less</span>
          <div className="flex gap-0.5">
            {[0.15, 0.35, 0.55, 0.75, 1].map((opacity) => (
              <div
                key={opacity}
                className="w-3 h-3 rounded-sm"
                style={{
                  backgroundColor: `${VIZ.activity.rgba(opacity)}`,
                }}
              />
            ))}
          </div>
          <span>More</span>
        </div>
      </div>
    </Panel>
  );
}

function Panel({ title, tooltip, children }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 h-full">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3" title={tooltip}>
        {title}
      </h2>
      {children}
    </div>
  );
}
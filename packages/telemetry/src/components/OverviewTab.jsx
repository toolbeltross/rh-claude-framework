import MetricCard from './MetricCard';
import DailyActivity from './DailyActivity';
import HourlyHeatmap from './HourlyHeatmap';

function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export default function OverviewTab({ stats, sessions, onSelectSession, displayMode = 'cost', failurePatterns }) {
  const isTokenMode = displayMode === 'tokens';
  const totalSessions = stats?.totalSessions ?? '—';
  const totalMessages = stats?.totalMessages ?? '—';
  const firstDate = stats?.firstSessionDate
    ? new Date(stats.firstSessionDate).toLocaleDateString()
    : '—';
  const totalCost = sessions?.reduce((sum, s) => sum + (s.cost || 0), 0) ?? 0;
  const totalTokens = sessions?.reduce((sum, s) => sum + (s.tokens?.total || 0), 0) ?? 0;

  return (
    <div className="grid grid-cols-12 gap-3">
      {/* Summary Cards */}
      <div className="col-span-3 bg-gray-900 border border-gray-800 rounded-lg p-4 flex flex-col justify-center gap-4">
        <MetricCard label="Total Sessions" value={totalSessions} color="text-accent" tooltip="Cumulative number of Claude Code sessions across all projects" />
        <MetricCard label="Total Messages" value={totalMessages} color="text-blue" tooltip="Total conversation messages exchanged across all sessions" />
        {isTokenMode ? (
          <MetricCard label="Total Tokens" value={formatTokens(totalTokens)} color="text-green" tooltip="Sum of tokens consumed across all tracked sessions" />
        ) : (
          <MetricCard label="Total Cost" value={`$${totalCost.toFixed(2)}`} color="text-green" tooltip="Sum of API costs across all tracked sessions" />
        )}
        <MetricCard label="First Session" value={firstDate} color="text-gray-100" tooltip="Date of the earliest recorded Claude Code session" />
        {failurePatterns?.total > 0 && (
          <MetricCard
            label="Total Failures"
            value={failurePatterns.total}
            color="text-red"
            tooltip={`Persistent failure count across all sessions. Top failing tool: ${
              Object.entries(failurePatterns.byTool || {}).sort((a, b) => b[1] - a[1])[0]?.[0] || 'none'
            }`}
          />
        )}
      </div>

      {/* Daily Activity */}
      <div className="col-span-9">
        <DailyActivity stats={stats} displayMode={displayMode} />
      </div>

      {/* Hourly Heatmap */}
      <div className="col-span-12">
        <HourlyHeatmap stats={stats} />
      </div>

      {/* Recent Sessions */}
      {sessions?.length > 0 && (
        <div className="col-span-12 bg-gray-900 border border-gray-800 rounded-lg p-4">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3" title="Last session per project from .claude.json — click a row to open its detail tab">
            Recent Sessions ({sessions.length})
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500 uppercase tracking-wider">
                  <th className="text-left pb-2 font-medium" title="Project directory name">Project</th>
                  <th className="text-left pb-2 font-medium" title="Unique session identifier (first 8 characters)">Session</th>
                  <th className="text-left pb-2 font-medium" title="Primary Claude model used in the session">Model</th>
                  <th className="text-right pb-2 font-medium" title={isTokenMode ? "Total tokens consumed" : "Total API cost in USD"}>
                    {isTokenMode ? 'Tokens' : 'Cost'}
                  </th>
                  <th className="text-right pb-2 font-medium" title="Total elapsed session time">Duration</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr
                    key={s.sessionId}
                    onClick={() => onSelectSession(s)}
                    className="border-t border-gray-800 hover:bg-gray-800/50 cursor-pointer transition-colors"
                  >
                    <td className="py-2 text-gray-200 font-medium">{s.projectName}</td>
                    <td className="py-2 text-gray-400 font-mono text-xs">{s.sessionId.slice(0, 8)}</td>
                    <td className="py-2 text-gray-300">{s.primaryModel}</td>
                    <td className="py-2 text-right text-green font-mono">
                      {isTokenMode ? formatTokens(s.tokens?.total || 0) : `$${s.cost.toFixed(4)}`}
                    </td>
                    <td className="py-2 text-right text-gray-400">{s.duration}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
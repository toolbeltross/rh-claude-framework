import { PieChart, Pie, Cell, ResponsiveContainer } from 'recharts';
import InfoIcon, { Legend } from './InfoIcon';
import { MODEL_HEX } from '../lib/model-colors';

export default function ModelBreakdownMini({ session, liveSession, displayMode = 'cost' }) {
  const isTokenMode = displayMode === 'tokens';
  // Prefer live session data when available — file-based models can lag behind
  const liveModel = liveSession?.model?.display_name || liveSession?.model?.id;
  const liveCost = liveSession?.cost?.total_cost_usd;

  // Token data from context_window for live sessions
  const liveTokens = (liveSession?.context_window?.current_usage?.input_tokens ?? 0) +
                     (liveSession?.context_window?.current_usage?.output_tokens ?? 0);

  // Build data array from whichever source is available
  let data = [];
  let isLive = false;

  if (liveSession && liveModel) {
    const friendlyName = friendlyModel(liveModel);
    if (isTokenMode) {
      data = [{ name: friendlyName, value: liveTokens, cost: liveCost || 0 }];
    } else {
      data = [{ name: friendlyName, value: liveCost || 0, cost: liveCost || 0 }];
    }
    isLive = true;
  }

  // Also pull in file-based models if available
  if (data.length === 0) {
    const models = session?.models || [];
    if (isTokenMode) {
      data = models
        .filter((m) => (m.inputTokens || 0) + (m.outputTokens || 0) > 0)
        .map((m) => ({
          name: m.name,
          value: (m.inputTokens || 0) + (m.outputTokens || 0),
          cost: m.cost || 0,
        }));
    } else {
      data = models
        .filter((m) => m.cost > 0)
        .map((m) => ({
          name: m.name,
          value: parseFloat(m.cost.toFixed(2)),
          cost: parseFloat(m.cost.toFixed(2)),
        }));
    }
  }

  const infoContent = (
    <div className="space-y-1.5">
      <p>{isTokenMode ? 'Token' : 'Cost'} distribution by model. Subagents automatically use cheaper models.</p>
      <div className="flex flex-wrap gap-x-1 gap-y-0.5">
        <Legend color="bg-accent" label="Opus" />
        <Legend color="bg-blue" label="Sonnet" />
        <Legend color="bg-cyan" label="Haiku" />
      </div>
    </div>
  );

  // Nothing at all
  if (data.length === 0) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 h-full flex flex-col">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400">Models</h2>
          <InfoIcon>{infoContent}</InfoIcon>
        </div>
        <p className="text-gray-600 text-[10px]">No data</p>
      </div>
    );
  }

  const total = data.reduce((sum, d) => sum + d.value, 0);

  // For pie chart: if value is 0 for all, use equal slices so the chart still renders
  const pieData = total > 0 ? data : data.map((d) => ({ ...d, value: 1 }));

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 h-full flex flex-col">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400">Models</h2>
        <InfoIcon>{infoContent}</InfoIcon>
      </div>
      <div className="flex items-center gap-1.5 flex-1">
        <div className="w-12 h-12 shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={pieData} cx="50%" cy="50%" innerRadius={12} outerRadius={22} paddingAngle={data.length > 1 ? 2 : 0} dataKey="value" strokeWidth={0}>
                {pieData.map((entry) => (
                  <Cell key={entry.name} fill={MODEL_HEX[entry.name] || '#3a3a4a'} />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
        </div>
        <div className="flex flex-col gap-1 flex-1 min-w-0">
          {data.map((entry) => (
            <div key={entry.name} className="flex items-center gap-1" title={isTokenMode
              ? `${entry.name}: ${formatTokens(entry.value)}${total > 0 ? ` (${Math.round((entry.value / total) * 100)}% of total)` : ''}`
              : `${entry.name}: $${entry.cost}${total > 0 ? ` (${Math.round((entry.value / total) * 100)}% of total)` : ''}`
            }>
              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: MODEL_HEX[entry.name] || '#3a3a4a' }} />
              <span className="text-[11px] text-gray-300 shrink-0">{entry.name}</span>
              {entry.value > 0 && (
                <span className="text-[11px] font-mono text-gray-400 truncate min-w-0">
                  {isTokenMode ? formatTokens(entry.value) : `$${entry.cost}`}
                </span>
              )}
            </div>
          ))}

        </div>
      </div>
    </div>
  );
}

function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 100_000) return `${Math.round(n / 1_000)}K`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function friendlyModel(model) {
  if (!model) return '';
  if (model.includes('opus') || model.includes('Opus')) return 'Opus';
  if (model.includes('sonnet') || model.includes('Sonnet')) return 'Sonnet';
  if (model.includes('haiku') || model.includes('Haiku')) return 'Haiku';
  return model;
}
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { MODEL_HEX, getModelFamily } from '../lib/model-colors';

function friendlyModel(modelId) {
  const fam = getModelFamily(modelId);
  if (fam === 'Opus' || fam === 'Sonnet' || fam === 'Haiku') return fam;
  return modelId.replace('claude-', '').split('-').slice(0, 2).join(' ');
}

function modelColor(friendlyName) {
  return MODEL_HEX[friendlyName] || '#a78bfa';
}

function formatTokenTick(v) {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(0)}K`;
  return String(v);
}

function formatTokenTooltip(v) {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(v);
}

export default function DailyActivity({ stats, displayMode = 'cost' }) {
  const isTokenMode = displayMode === 'tokens';

  // Token mode: show daily token consumption by model
  if (isTokenMode && stats?.dailyModelTokens?.length) {
    // Group raw model IDs by friendly family name (Opus/Sonnet/Haiku) so multiple
    // variants (e.g. claude-sonnet-4-5 + claude-sonnet-4-6) collapse into one
    // legend entry instead of producing duplicate bars with the same dataKey.
    const familyToIds = new Map();
    stats.dailyModelTokens.forEach(d =>
      Object.keys(d.tokensByModel || {}).forEach(id => {
        const fam = friendlyModel(id);
        if (!familyToIds.has(fam)) familyToIds.set(fam, []);
        familyToIds.get(fam).push(id);
      })
    );
    const families = [...familyToIds.keys()].map(name => ({
      name,
      ids: [...new Set(familyToIds.get(name))],
    }));

    const data = stats.dailyModelTokens.map(d => {
      const row = { date: d.date.slice(5) };
      families.forEach(({ name, ids }) => {
        row[name] = ids.reduce((sum, id) => sum + (d.tokensByModel?.[id] || 0), 0);
      });
      return row;
    });

    return (
      <Panel title="Daily Token Consumption" tooltip="Tokens consumed per day by model — stacked bars show total daily burn with model breakdown">
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={data}>
            <XAxis
              dataKey="date"
              tick={{ fill: '#8888a0', fontSize: 11 }}
              axisLine={{ stroke: '#2a2a38' }}
              tickLine={false}
            />
            <YAxis
              tick={{ fill: '#8888a0', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={50}
              tickFormatter={formatTokenTick}
            />
            <Tooltip
              contentStyle={{
                background: '#1a1a24',
                border: '1px solid #2a2a38',
                borderRadius: 6,
                fontSize: 12,
              }}
              labelStyle={{ color: '#e0e0ee' }}
              formatter={(value, name) => [formatTokenTooltip(value), name]}
            />
            <Legend
              iconSize={8}
              wrapperStyle={{ fontSize: 11, color: '#8888a0' }}
            />
            {families.map(({ name }) => (
              <Bar key={name} dataKey={name} stackId="tokens" fill={modelColor(name)} radius={[2, 2, 0, 0]} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </Panel>
    );
  }

  // Default: Messages / Sessions / Tools
  if (!stats?.dailyActivity?.length) {
    return (
      <Panel title="Daily Activity" tooltip="Messages, sessions, and tool calls per day from stats-cache.json">
        <p className="text-gray-400 text-sm">No data</p>
      </Panel>
    );
  }

  const data = stats.dailyActivity.map((d) => ({
    date: d.date.slice(5), // MM-DD
    Messages: d.messageCount,
    Sessions: d.sessionCount,
    Tools: d.toolCallCount,
  }));

  return (
    <Panel title="Daily Activity" tooltip="Messages, sessions, and tool calls per day from stats-cache.json">
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data} barGap={2}>
          <XAxis
            dataKey="date"
            tick={{ fill: '#8888a0', fontSize: 11 }}
            axisLine={{ stroke: '#2a2a38' }}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: '#8888a0', fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={40}
          />
          <Tooltip
            contentStyle={{
              background: '#1a1a24',
              border: '1px solid #2a2a38',
              borderRadius: 6,
              fontSize: 12,
            }}
            labelStyle={{ color: '#e0e0ee' }}
          />
          <Legend
            iconSize={8}
            wrapperStyle={{ fontSize: 11, color: '#8888a0' }}
          />
          <Bar dataKey="Messages" fill="#34d399" radius={[2, 2, 0, 0]} />
          <Bar dataKey="Sessions" fill="#fbbf24" radius={[2, 2, 0, 0]} />
          <Bar dataKey="Tools" fill="#aaaabb" radius={[2, 2, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
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
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import InfoIcon, { Legend } from './InfoIcon';

function getModelColor(name) {
  if (name.startsWith('Opus')) return '#8b5cf6';
  if (name.startsWith('Sonnet')) return '#60a5fa';
  if (name.startsWith('Haiku')) return '#22d3ee';
  return '#3a3a4a';
}

export default function ModelBreakdown({ session }) {
  if (!session?.models?.length) {
    return (
      <Panel title="Model Breakdown">
        <p className="text-gray-400 text-sm">No data</p>
      </Panel>
    );
  }

  const data = session.models
    .filter((m) => m.cost > 0)
    .map((m) => ({
      name: m.name,
      value: parseFloat(m.cost.toFixed(2)),
    }));

  return (
    <Panel title="Model Breakdown" tooltip="Cost by model. Subagents use cheaper models (Haiku, Sonnet) automatically — this is why models you didn't select appear here." infoContent={
      <div className="space-y-1.5">
        <p>Cost distribution by model. Subagents automatically use cheaper models.</p>
        <div className="flex flex-wrap gap-x-1 gap-y-0.5"><Legend color="bg-accent" label="Opus" /><Legend color="bg-blue" label="Sonnet" /><Legend color="bg-cyan" label="Haiku" /></div>
      </div>
    }>
      <div className="flex items-center gap-4">
        <ResponsiveContainer width={140} height={140}>
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="50%"
              innerRadius={35}
              outerRadius={60}
              paddingAngle={2}
              dataKey="value"
              strokeWidth={0}
            >
              {data.map((entry) => (
                <Cell
                  key={entry.name}
                  fill={getModelColor(entry.name)}
                />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{
                background: '#1a1a24',
                border: '1px solid #2a2a38',
                borderRadius: 6,
                fontSize: 12,
              }}
              formatter={(value) => [`$${value}`, 'Cost']}
            />
          </PieChart>
        </ResponsiveContainer>

        <div className="flex flex-col gap-2">
          {data.map((entry) => (
            <div key={entry.name} className="flex items-center gap-2">
              <span
                className="w-3 h-3 rounded-full"
                style={{
                  backgroundColor:
                    getModelColor(entry.name),
                }}
              />
              <span className="text-sm text-gray-300">{entry.name}</span>
              <span className="text-sm font-mono text-gray-400">
                ${entry.value}
              </span>
            </div>
          ))}
        </div>
      </div>
    </Panel>
  );
}

function Panel({ title, tooltip, infoContent, children }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 h-full">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400" title={tooltip}>
          {title}
        </h2>
        {infoContent && <InfoIcon>{infoContent}</InfoIcon>}
      </div>
      {children}
    </div>
  );
}
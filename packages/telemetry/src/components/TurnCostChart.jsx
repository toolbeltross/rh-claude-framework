import { BarChart, Bar, XAxis, YAxis, Tooltip, ReferenceLine, ResponsiveContainer } from 'recharts';
import InfoIcon, { Legend } from './InfoIcon';

export default function TurnCostChart({ liveSession, displayMode = 'cost' }) {
  if (!liveSession) return null;

  const history = liveSession._turnHistory || [];
  if (history.length < 2) return null;

  const isTokenMode = displayMode === 'tokens';

  // Prepare data: last 20 non-compact entries, mark compact events
  const data = [];
  const compactTurns = [];
  const recent = history.slice(-20);

  for (let i = 0; i < recent.length; i++) {
    const entry = recent[i];
    if (entry.compact) {
      compactTurns.push(entry.turn || data.length);
    } else {
      // Token delta: difference in total tokens from previous non-compact entry
      let tokensDelta = 0;
      for (let j = i - 1; j >= 0; j--) {
        if (!recent[j].compact) {
          tokensDelta = Math.max(0, entry.tokens - recent[j].tokens);
          break;
        }
      }
      data.push({
        turn: entry.turn,
        cost: Math.round(entry.cost * 100) / 100,
        tokensDelta,
        tokens: entry.tokens,
      });
    }
  }

  if (data.length < 2) return null;

  const dataKey = isTokenMode ? 'tokensDelta' : 'cost';
  const title = isTokenMode ? 'Turn Tokens' : 'Turn Cost';
  const infoContent = (
    <div className="space-y-1.5">
      <p>{isTokenMode ? 'Tokens consumed per turn.' : 'Cost per turn.'} Higher bars = heavier turns.</p>
      <div className="flex flex-wrap gap-x-1 gap-y-0.5"><Legend color="bg-accent" label="bar" /><Legend color="bg-red" label="compaction" /></div>
    </div>
  );

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-gray-400" title={isTokenMode ? 'Tokens consumed per turn — red dashed lines indicate compaction events' : 'Cost per turn over the last 20 turns — red dashed lines indicate context compaction events'}>
          {title}
        </span>
        <InfoIcon>{infoContent}</InfoIcon>
      </div>
      <div className="mt-2" style={{ width: '100%', height: 80 }}>
        <ResponsiveContainer>
          <BarChart data={data} margin={{ top: 2, right: 4, bottom: 0, left: 0 }}>
            <XAxis dataKey="turn" tick={{ fontSize: 9, fill: '#8888a0' }} tickLine={false} axisLine={false} />
            <YAxis
              tick={{ fontSize: 9, fill: '#8888a0' }}
              tickLine={false}
              axisLine={false}
              width={30}
              tickFormatter={isTokenMode ? formatTokenTick : (v) => `$${v}`}
            />
            <Tooltip
              contentStyle={{ background: '#1a1a24', border: '1px solid #2a2a38', borderRadius: 6, fontSize: 11 }}
              labelFormatter={(v) => `Turn ${v}`}
              formatter={isTokenMode
                ? (value) => [formatTokens(value), 'Tokens']
                : (value) => [`$${value.toFixed(2)}`, 'Cost']
              }
            />
            <Bar dataKey={dataKey} fill="#8b5cf6" radius={[2, 2, 0, 0]} maxBarSize={20} />
            {compactTurns.map((turn) => (
              <ReferenceLine key={`compact-${turn}`} x={turn} stroke="#f87171" strokeDasharray="4 3" strokeWidth={1.5} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function formatTokenTick(v) {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${Math.round(v / 1_000)}K`;
  return String(v);
}

function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
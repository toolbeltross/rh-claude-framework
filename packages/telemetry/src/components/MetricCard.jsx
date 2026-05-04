export default function MetricCard({ label, value, sub, color = 'text-gray-100', tooltip }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wider text-gray-400" title={tooltip}>
        {label}
      </span>
      <span className={`text-xl font-bold ${color}`}>{value}</span>
      {sub && <span className="text-xs text-gray-400">{sub}</span>}
    </div>
  );
}
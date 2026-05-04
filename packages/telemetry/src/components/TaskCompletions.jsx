import InfoIcon from './InfoIcon';

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  const s = d.getSeconds().toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}

const STATUS_COLORS = {
  completed: 'bg-green',
  in_progress: 'bg-blue animate-pulse-dot',
  pending: 'bg-gray-500',
  cancelled: 'bg-gray-600',
  failed: 'bg-red',
};

/**
 * Shows the last N TaskCompleted hook events for the session.
 * Fed by the TaskCompleted hook → /api/task-completed → store → WebSocket.
 */
export default function TaskCompletions({ liveSession }) {
  const tasks = liveSession?._completedTasks || [];

  if (tasks.length === 0) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-2">
        <div className="flex items-center gap-2 mb-1">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400 inline-flex items-center gap-1.5" title="TodoWrite / TaskCompleted hook events from the current session">
            Task Completions
            <InfoIcon>
              <p className="text-[11px] text-gray-400">Each entry is a task that Claude reported completed via the TaskCompleted hook. Helps you correlate tool activity bursts with what Claude was actually finishing.</p>
            </InfoIcon>
          </h2>
          <span className="text-[11px] text-gray-500">no entries this session</span>
        </div>
      </div>
    );
  }

  // Reverse so most recent is at top
  const rows = tasks.slice().reverse();

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-2">
      <div className="flex items-center gap-2 mb-1.5">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400 inline-flex items-center gap-1.5" title="TodoWrite / TaskCompleted hook events">
          Task Completions
          <InfoIcon>
            <p className="text-[11px] text-gray-400">Each entry is a task Claude reported completed via the TaskCompleted hook.</p>
          </InfoIcon>
        </h2>
        <span className="text-xs text-gray-500 font-mono">{tasks.length}</span>
      </div>
      <div className="space-y-0.5 max-h-48 overflow-auto">
        {rows.map((task, i) => {
          const dotColor = STATUS_COLORS[task.status] || 'bg-gray-500';
          return (
            <div key={task.task_id || i} className="flex items-center gap-2 text-xs py-0.5 hover:bg-gray-800/50 rounded px-1">
              <span className="text-gray-500 font-mono shrink-0 text-[11px]" title={new Date(task.ts).toISOString()}>
                {formatTime(task.ts)}
              </span>
              <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${dotColor}`} title={task.status} />
              <span className="text-gray-300 truncate">
                {task.task_description || task.task_id || '(no description)'}
              </span>
              <span className="text-gray-600 text-[10px] ml-auto shrink-0">{task.status}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

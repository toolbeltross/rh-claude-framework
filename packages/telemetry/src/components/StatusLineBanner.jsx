import { useState, useEffect, useRef } from 'react';

/**
 * Standalone modal showing statusLine diagnostic details and repair instructions.
 * Extracted so it can be opened from the header health dot (App.jsx) without
 * needing the full banner component.
 */
export function StatusLineModal({ statusLineState, onClose }) {
  const ref = useRef(null);

  useEffect(() => {
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    }
    function handleKey(e) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  if (!statusLineState) return null;
  const { class: slClass, stalled, command, reason, scriptPath, lastStatusPostAt, lastCheckedAt } = statusLineState;

  let severity, label, description;
  if (stalled) {
    severity = 'error';
    label = 'statusLine stalled';
    description = 'Tool events are flowing but no statusLine posts have arrived for over 2 minutes. The forwarder may be crashing or the telemetry port may be unreachable.';
  } else if (slClass === 'missing') {
    severity = 'error';
    label = 'statusLine not configured';
    description = 'settings.json has no statusLine command. Dashboard context window cannot update in real time.';
  } else if (slClass === 'placeholder') {
    severity = 'warn';
    label = 'statusLine outdated (placeholder)';
    description = 'The legacy fallback statusline script is still active. It does not forward data to telemetry.';
  } else if (slClass === 'unknown-custom') {
    severity = 'warn';
    label = 'statusLine custom (not forwarding)';
    description = 'A custom statusLine script is in place that does not forward data to the telemetry server. Dashboard context updates will only arrive via tool events (~5-30 s gaps).';
  } else {
    severity = 'warn';
    label = `statusLine: ${slClass}`;
    description = reason || 'statusLine configuration is not fully healthy.';
  }

  return (
    <div data-testid="statusline-modal" className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div ref={ref} className="relative bg-gray-900 border border-gray-700 rounded-xl p-6 shadow-2xl max-w-lg w-full mx-4">
        <button
          onClick={onClose}
          className="absolute top-3 right-3 text-gray-500 hover:text-gray-300 transition-colors text-lg leading-none"
          title="Close"
        >
          x
        </button>
        <h2 className={`text-sm font-bold uppercase tracking-wider mb-3 ${severity === 'error' ? 'text-red' : 'text-amber'}`}>
          {label}
        </h2>
        <p className="text-xs text-gray-300 mb-4 leading-relaxed">{description}</p>

        <div className="space-y-2 text-xs mb-4">
          <div>
            <div className="text-gray-500 text-[10px] uppercase tracking-wider mb-0.5">Current command</div>
            <div className="font-mono bg-gray-950 border border-gray-800 rounded px-2 py-1.5 text-gray-200 break-all">
              {command || <span className="text-gray-600">(not set)</span>}
            </div>
          </div>
          {scriptPath && (
            <div>
              <div className="text-gray-500 text-[10px] uppercase tracking-wider mb-0.5">Script path</div>
              <div className="font-mono text-gray-400 break-all">{scriptPath}</div>
            </div>
          )}
          {reason && (
            <div>
              <div className="text-gray-500 text-[10px] uppercase tracking-wider mb-0.5">Reason</div>
              <div className="text-gray-400">{reason}</div>
            </div>
          )}
          {lastStatusPostAt !== null && lastStatusPostAt !== undefined && (
            <div>
              <div className="text-gray-500 text-[10px] uppercase tracking-wider mb-0.5">Last statusLine post</div>
              <div className="text-gray-400">
                {new Date(lastStatusPostAt).toLocaleTimeString()} ({Math.round((Date.now() - lastStatusPostAt) / 1000)}s ago)
              </div>
            </div>
          )}
          {lastCheckedAt && (
            <div>
              <div className="text-gray-500 text-[10px] uppercase tracking-wider mb-0.5">Last classified</div>
              <div className="text-gray-400">{new Date(lastCheckedAt).toLocaleTimeString()}</div>
            </div>
          )}
        </div>

        <div className="border-t border-gray-800 pt-4">
          <div className="text-gray-500 text-[10px] uppercase tracking-wider mb-2">Fix</div>
          <p className="text-xs text-gray-300 mb-2">Run from a terminal:</p>
          <code className="block bg-gray-950 border border-gray-800 rounded px-3 py-2 text-accent font-mono text-[11px]">
            rh-telemetry repair-statusline
          </code>
          <p className="text-[11px] text-gray-500 mt-2 leading-relaxed">
            This classifies your current statusLine and offers to replace, wrap (preserve custom display + add forwarding), or skip. A history of all changes is kept at <code className="text-gray-400">~/.claude/telemetry-statusline-history.jsonl</code>.
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * Banner shown in the header when the statusLine configuration is degraded or
 * stalled. Hidden entirely when healthy (telemetry / telemetry-wrapper AND not stalled).
 *
 * DEPRECATED — replaced by the health dot in the icon strip + StatusLineModal.
 * Kept for backwards compatibility if anyone imports the default export.
 */
export default function StatusLineBanner({ statusLineState }) {
  const [open, setOpen] = useState(false);

  if (!statusLineState) return null;
  const { class: slClass, stalled } = statusLineState;
  const healthy = (slClass === 'telemetry' || slClass === 'telemetry-wrapper') && !stalled;
  if (healthy) return null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded border text-[11px] font-semibold uppercase tracking-wider transition-colors text-amber bg-amber/10 border-amber/30 hover:bg-amber/20"
      >
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-current animate-pulse-dot" />
        statusLine issue
      </button>
      {open && <StatusLineModal statusLineState={statusLineState} onClose={() => setOpen(false)} />}
    </>
  );
}

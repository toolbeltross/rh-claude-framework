import { useState, useRef, useEffect } from 'react';

export default function InfoIcon({ text, children }) {
  const [open, setOpen] = useState(false);
  const [align, setAlign] = useState('left');
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    // Auto-detect best direction based on viewport position
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect();
      setAlign(rect.left < window.innerWidth / 2 ? 'left' : 'right');
    }
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  return (
    <span className="relative inline-flex" ref={ref}>
      <span
        onClick={() => setOpen(v => !v)}
        className="text-[11px] text-gray-600 hover:text-gray-400 cursor-pointer select-none leading-none"
        title="Click for more info"
      >
        &#9432;
      </span>
      {open && (
        <div className={`absolute ${align === 'left' ? 'left-0' : 'right-0'} top-5 bg-gray-800 border border-gray-700 rounded-lg p-3 text-xs text-gray-300 w-80 z-50 whitespace-normal leading-relaxed shadow-xl`}>
          {children || text}
        </div>
      )}
    </span>
  );
}

/** Styled color legend dot + label for use inside InfoIcon tooltips */
export function Legend({ color, label }) {
  return (
    <span className="inline-flex items-center gap-1 mr-2">
      <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${color}`} />
      <span>{label}</span>
    </span>
  );
}
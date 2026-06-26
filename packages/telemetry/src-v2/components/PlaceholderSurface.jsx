export default function PlaceholderSurface({ title, phaseRef, hint }) {
  return (
    <div className="p-12 flex flex-col items-center justify-center h-full text-center">
      <div className="text-xs uppercase tracking-wider text-gray-500 mb-2">{title}</div>
      <div className="text-sm text-gray-400 mb-1">Surface scaffold — implementation pending</div>
      <div className="text-xs text-gray-600 mb-4">{phaseRef}</div>
      {hint && (
        <div className="max-w-md text-xs text-gray-500 border border-gray-800 rounded-lg p-4 bg-gray-900">
          {hint}
        </div>
      )}
    </div>
  );
}

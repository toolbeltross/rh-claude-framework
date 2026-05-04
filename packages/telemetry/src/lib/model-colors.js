/**
 * Shared model color constants for consistent visual language across the dashboard.
 *
 * Opus = purple (accent), Sonnet = blue, Haiku = cyan.
 * These match the existing theme in index.css and the donut chart in ModelBreakdownMini.
 */

export const MODEL_COLORS = {
  Opus:   { hex: '#8b5cf6', text: 'text-accent', bg: 'bg-accent/10', border: 'border-accent/30' },
  Sonnet: { hex: '#60a5fa', text: 'text-blue',   bg: 'bg-blue/10',   border: 'border-blue/30' },
  Haiku:  { hex: '#22d3ee', text: 'text-cyan',   bg: 'bg-cyan/10',   border: 'border-cyan/30' },
};

const DEFAULT_COLOR = { hex: '#3a3a4a', text: 'text-gray-400', bg: 'bg-gray-800/50', border: 'border-gray-700' };

/**
 * Resolve a model name or ID string to a MODEL_COLORS key.
 * Accepts: "Opus 4.6", "claude-opus-4-6", "Opus", display names, etc.
 */
export function getModelColor(nameOrId) {
  if (!nameOrId) return DEFAULT_COLOR;
  const s = typeof nameOrId === 'string' ? nameOrId.toLowerCase() : '';
  if (s.includes('opus')) return MODEL_COLORS.Opus;
  if (s.includes('sonnet')) return MODEL_COLORS.Sonnet;
  if (s.includes('haiku')) return MODEL_COLORS.Haiku;
  return DEFAULT_COLOR;
}

/**
 * Resolve to the short model family name: "Opus", "Sonnet", "Haiku", or the original string.
 */
export function getModelFamily(nameOrId) {
  if (!nameOrId) return '';
  const s = typeof nameOrId === 'string' ? nameOrId.toLowerCase() : '';
  if (s.includes('opus')) return 'Opus';
  if (s.includes('sonnet')) return 'Sonnet';
  if (s.includes('haiku')) return 'Haiku';
  return nameOrId;
}

/** Hex color map for Recharts and other non-Tailwind contexts */
export const MODEL_HEX = {
  Opus: MODEL_COLORS.Opus.hex,
  Sonnet: MODEL_COLORS.Sonnet.hex,
  Haiku: MODEL_COLORS.Haiku.hex,
};

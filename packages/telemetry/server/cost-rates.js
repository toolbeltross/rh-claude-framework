/**
 * Shared model pricing rates for cost estimation.
 *
 * Rates are per 1M tokens. Used by:
 * - hook-forwarder.js (transcript cost calculation)
 * - store.js (subagent cost estimation fallback)
 */

/** Per-model pricing tiers (USD per 1M tokens) */
export const MODEL_RATES = {
  opus: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  sonnet: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  haiku: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
};

/**
 * Determine pricing tier from a model ID string.
 * @param {string} modelId - Model ID or display name (e.g., "claude-opus-4-6", "Sonnet 4.6")
 * @returns {'opus'|'sonnet'|'haiku'} Pricing tier (defaults to 'sonnet' if unknown)
 */
export function getTier(modelId) {
  if (!modelId) return 'sonnet';
  const id = modelId.toLowerCase();
  if (id.includes('opus')) return 'opus';
  if (id.includes('haiku')) return 'haiku';
  return 'sonnet';
}

/**
 * Estimate cost from token counts and a model identifier.
 * @param {string} modelId - Model ID or display name
 * @param {{ input?: number, output?: number, cacheRead?: number, cacheWrite?: number }} tokens
 * @returns {number} Estimated cost in USD
 */
export function estimateCost(modelId, tokens = {}) {
  const tier = getTier(modelId);
  const p = MODEL_RATES[tier];
  const input = tokens.input || 0;
  const output = tokens.output || 0;
  const cacheRead = tokens.cacheRead || 0;
  const cacheWrite = tokens.cacheWrite || 0;
  return (input / 1e6) * p.input +
         (output / 1e6) * p.output +
         (cacheRead / 1e6) * p.cacheRead +
         (cacheWrite / 1e6) * p.cacheWrite;
}

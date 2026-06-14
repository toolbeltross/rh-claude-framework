/**
 * cost-rates.js — CJS model pricing mirror for context-db telemetry capture.
 *
 * The CANONICAL rates live in packages/telemetry/server/cost-rates.js (ESM).
 * Deployed scripts under ~/.claude/scripts/ are CJS with no node_modules and
 * cannot import the ESM telemetry package, so this is a deliberate small mirror
 * (3 tiers, rarely change). Keep the rates in sync with the telemetry canonical;
 * if they drift, the telemetry dashboard is the source of truth.
 *
 * Rates are USD per 1M tokens.
 */

const MODEL_RATES = {
  opus:   { input: 15,  output: 75, cacheRead: 1.5,  cacheWrite: 18.75 },
  sonnet: { input: 3,   output: 15, cacheRead: 0.3,  cacheWrite: 3.75 },
  haiku:  { input: 0.8, output: 4,  cacheRead: 0.08, cacheWrite: 1 },
};

// Map a model id/display string to a pricing tier. Defaults to sonnet (matches
// the telemetry canonical's conservative middle-tier default for unknowns).
function getTier(modelId) {
  if (!modelId) return 'sonnet';
  const id = String(modelId).toLowerCase();
  if (id.includes('opus')) return 'opus';
  if (id.includes('haiku')) return 'haiku';
  return 'sonnet';
}

// Estimate USD cost from token counts + a model id. tokens: {input, output,
// cacheRead, cacheWrite}. Returns a number (0 when all token counts are 0).
function estimateCost(modelId, tokens = {}) {
  const p = MODEL_RATES[getTier(modelId)];
  return ((tokens.input || 0) / 1e6) * p.input +
         ((tokens.output || 0) / 1e6) * p.output +
         ((tokens.cacheRead || 0) / 1e6) * p.cacheRead +
         ((tokens.cacheWrite || 0) / 1e6) * p.cacheWrite;
}

module.exports = { MODEL_RATES, getTier, estimateCost };

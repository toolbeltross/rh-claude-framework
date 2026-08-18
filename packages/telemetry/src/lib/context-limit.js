/**
 * Context-window size resolution for FILE-based sessions.
 *
 * Live sessions get their window straight from the statusLine payload
 * (`context_window.context_window_size`). File-based sessions have no such
 * payload, so the size has to be resolved from what the session itself reveals.
 *
 * WHY THIS MOVED OUT OF ContextWindow.jsx (2026-08-15)
 * ---------------------------------------------------
 * It previously lived inline in the component and matched a hardcoded table:
 *
 *     { 'claude-opus-4': 200000, 'claude-sonnet-4': 200000, 'claude-haiku-4': 200000 }
 *
 * That table was generation-locked. The substring `claude-opus-4` stops
 * matching the moment `claude-opus-5` ships, so every Claude 5 file session
 * fell through to `null` and the gauge rendered "?" with no size and no
 * percentage. This also silently falsified the package's own Known Issues note
 * that file-based sessions "default to 200K" — true when every model was 4.x,
 * quietly untrue afterwards.
 *
 * Matching on model FAMILY rather than family+generation fixes it for every
 * future release. Living in src/lib/ as plain .js (not .jsx) also makes it
 * directly unit-testable — the test harness is plain Node with no JSX
 * transform, so a function inside a component file cannot be imported.
 */

export const BASE_CONTEXT_SIZE = 200_000;
export const EXTENDED_CONTEXT_SIZE = 1_000_000;
export const CONTEXT_SIZES = [BASE_CONTEXT_SIZE, EXTENDED_CONTEXT_SIZE];

/**
 * Resolve a context-window size from a model id, plus (optionally) the measured
 * end-of-session context fill.
 *
 * The extended 1M window is NEVER inferred from the model id alone. Measured
 * 2026-08-15: two concurrent `claude-opus-5` sessions reported 1M while the
 * same session had reported 200K earlier at lower usage — so the id genuinely
 * does not determine the window, and mapping `opus-5 → 1M` would attach a
 * fabricated number to every 200K session. 1M is concluded only from evidence:
 *
 *   1. an explicit marker in the id/display name (`[1m]`, "1M context"), or
 *   2. a context fill larger than the base window, which proves a bigger one.
 *
 * Mirrors the rule in `resolveContextWindowSize` (server/config.js), which
 * cannot be imported here — it pulls in path/os/fs and will not bundle for the
 * browser. Keep the two in sync.
 *
 * @param {string} modelId - Model id or display name
 * @param {number} [contextTokens=0] - Measured end-of-session context fill
 * @returns {number|null} Window size, or null when it cannot be determined
 */
export function getContextLimit(modelId, contextTokens = 0) {
  if (!modelId) return null;
  if (/\[1m\]|1m\s*context/i.test(modelId)) return EXTENDED_CONTEXT_SIZE;
  // Family match, generation-agnostic. Anything that isn't a recognised Claude
  // family returns null rather than defaulting — "unknown" is what parser.js
  // emits when .claude.json carries no model usage, and giving that a
  // real-looking 200K window would be inventing one.
  if (!/claude-(opus|sonnet|haiku)/i.test(modelId)) return null;
  if (contextTokens > BASE_CONTEXT_SIZE) return EXTENDED_CONTEXT_SIZE;
  return BASE_CONTEXT_SIZE;
}

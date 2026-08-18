/**
 * Adapters that reshape the live transcript aggregator's output into the
 * legacy parser.js shapes the v1 Overview surface consumes.
 *
 * WHY THIS EXISTS (2026-08-15)
 * ----------------------------
 * The v1 Overview tab is fed entirely by `server/parser.js`, which reads two
 * files that Claude Code itself writes:
 *
 *   1. `~/.claude/stats-cache.json`  — the source for every summary card and
 *      both activity charts.
 *   2. `~/.claude.json` → `projects[<path>].last*` — the source for the
 *      "Recent Sessions" table.
 *
 * Both have gone away underneath us. Measured on Claude Code 2.1.216:
 *   - `stats-cache.json` does not exist anywhere under `~/.claude`, so
 *     `parseStatsCache()` returns null and every card renders "—" with
 *     "No data" in the Daily Activity and Hourly Activity panels.
 *   - Of 13 projects in `.claude.json`, 12 carry no `last*` block at all and
 *     the 13th is zeroed (`lastCost: 0`, `lastModelUsage: {}`, all token
 *     counts 0). `parseAllSessions()` skips any project without a
 *     `lastSessionId`, so the table collapsed to a single row reading
 *     model "unknown" with no tokens.
 *
 * Nothing in this package broke — its own transcript aggregator
 * (`server/aggregates-store.js`, exposed at `/api/aggregates` and
 * `/api/sessions`) is accurate and live, which is why the Live, Sessions and
 * Subagents surfaces were unaffected throughout. The aggregator was already
 * written as the "stats-cache.json replacement" and already backs the v2
 * History surface; v1's Overview was simply never wired to it.
 *
 * ADDITIVE, per this package's project rules: the parser path is untouched
 * and still wins whenever it returns data. These adapters only supply a
 * fallback for when it returns nothing. If a future Claude Code release
 * restores either file, v1 Overview silently goes back to using it.
 */

import { estimateCost } from '../../server/cost-rates.js';

/**
 * Format a model ID into a short family + version name.
 * Mirrors `friendlyModelName` in server/parser.js. Duplicated rather than
 * imported because parser.js pulls in `fs/promises` and `./config.js`, which
 * cannot be bundled into the browser build.
 */
export function friendlyModelName(modelId) {
  if (!modelId) return 'unknown';
  const m = modelId.match(/claude-(opus|sonnet|haiku)-(\d+(?:-\d+)?)/i);
  if (m) {
    const family = m[1].charAt(0).toUpperCase() + m[1].slice(1);
    const version = m[2].replace('-', '.');
    return `${family} ${version}`;
  }
  if (modelId.includes('opus')) return 'Opus';
  if (modelId.includes('sonnet')) return 'Sonnet';
  if (modelId.includes('haiku')) return 'Haiku';
  return modelId;
}

/** Format milliseconds as a human-readable duration. Mirrors server/parser.js. */
export function formatDuration(ms) {
  if (!ms) return '0s';
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/** Last path segment of a POSIX or Windows path (no `path` module in the browser). */
function basename(p) {
  if (!p) return '';
  return p.split(/[/\\]/).filter(Boolean).pop() || '';
}

/**
 * Reshape `/api/aggregates` into the object `parseStatsCache()` produced.
 *
 * `dailyActivity`, `dailyModelTokens` and `hourCounts` already match field for
 * field, so they pass through untouched. The one divergence is `modelUsage`:
 * the aggregator emits `{ input, output, cacheRead, cacheWrite, cost }` while
 * the Overview's Total Tokens card reads `inputTokens` / `outputTokens`.
 * Left unnormalized it sums to 0 and the card silently falls through to a
 * cache-inclusive per-session total — a wrong number rather than a blank one,
 * which is the worse failure. Renaming here keeps OverviewTab untouched.
 *
 * @param {object|null} agg - GET /api/aggregates payload
 * @returns {object|null} parseStatsCache()-shaped stats
 */
export function adaptAggregates(agg) {
  if (!agg) return null;

  const modelUsage = {};
  for (const [id, m] of Object.entries(agg.modelUsage || {})) {
    modelUsage[id] = {
      ...m,
      inputTokens: m.input || 0,
      outputTokens: m.output || 0,
    };
  }

  return {
    dailyActivity: agg.dailyActivity || [],
    dailyModelTokens: agg.dailyModelTokens || [],
    modelUsage,
    totalSessions: agg.totalSessions || 0,
    totalMessages: agg.totalMessages || 0,
    longestSession: agg.longestSession || null,
    firstSessionDate: agg.firstSessionDate || null,
    hourCounts: agg.hourCounts || {},
  };
}

/**
 * Reshape `/api/sessions` rows into the session objects parser.js produces.
 *
 * The shape must match exactly, because clicking a Recent Sessions row calls
 * `handleFileSessionSelect`, which stashes the object and hands it straight to
 * `SessionTab` — so `models[]`, `tokens{}` and the `primaryModel` string all
 * have to look like the parser's output or the detail tab renders blanks.
 *
 * Per-model cost is not carried by `/api/sessions` (only session-level
 * `totalCost`), so it is derived here with the same `estimateCost` helper the
 * server uses for transcript costs — same rates, same token key names
 * (`input`/`output`/`cacheRead`/`cacheWrite`), so this introduces no second
 * pricing table to drift out of sync.
 *
 * @param {Array} aggSessions - `sessions` array from GET /api/sessions
 * @returns {Array} parser.js-shaped session objects, newest first
 */
export function adaptAggregateSessions(aggSessions) {
  if (!Array.isArray(aggSessions)) return [];

  return aggSessions.map((s) => {
    const modelMap = s.models || {};
    const models = Object.entries(modelMap).map(([id, m]) => ({
      id,
      name: friendlyModelName(id),
      inputTokens: m.input || 0,
      outputTokens: m.output || 0,
      cacheRead: m.cacheRead || 0,
      cacheWrite: m.cacheWrite || 0,
      cost: estimateCost(id, m),
    }));

    const tokens = models.reduce(
      (acc, m) => ({
        input: acc.input + m.inputTokens,
        output: acc.output + m.outputTokens,
        cacheRead: acc.cacheRead + m.cacheRead,
        cacheWrite: acc.cacheWrite + m.cacheWrite,
      }),
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    );

    return {
      sessionId: s.sessionId,
      projectPath: s.projectPath,
      projectName: basename(s.projectPath) || s.projectDir || 'unknown',
      cost: s.totalCost || 0,
      duration: formatDuration(s.durationMs),
      durationMs: s.durationMs || 0,
      primaryModel: friendlyModelName(s.primaryModel),
      primaryModelId: s.primaryModel || 'unknown',
      models,
      tokens: {
        ...tokens,
        total: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
      },
      // Not derivable from the aggregator — parser.js sourced these from
      // .claude.json's `last*` block. Zeroed rather than omitted so consumers
      // that read them get a number instead of undefined.
      linesAdded: 0,
      linesRemoved: 0,
      fps: 0,
      performance: null,
      apiDuration: 0,
      toolDuration: 0,
      lastActiveTs: s.lastTs || null,
      // Marks rows that came from the aggregator rather than .claude.json.
      _source: 'aggregator',
    };
  });
}

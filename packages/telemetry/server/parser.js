import { readFile } from 'fs/promises';
import { basename } from 'path';
import { CLAUDE_JSON_PATH, STATS_CACHE_PATH } from './config.js';

const CLAUDE_JSON = CLAUDE_JSON_PATH;
const STATS_CACHE = STATS_CACHE_PATH;

export { CLAUDE_JSON, STATS_CACHE };

async function readJSON(path) {
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[parser] Failed to read ${path}:`, err.message);
    return null;
  }
}

/** Find the most recently active project (the one with session metrics) */
function findActiveProject(claudeJson) {
  if (!claudeJson?.projects) return null;

  let best = null;
  let bestCost = -1;

  for (const [path, proj] of Object.entries(claudeJson.projects)) {
    if (proj.lastCost != null && proj.lastCost > bestCost) {
      bestCost = proj.lastCost;
      best = { path, ...proj };
    }
  }
  return best;
}

/** Format model ID into a friendly short name with version */
export function friendlyModelName(modelId) {
  if (!modelId) return 'unknown';
  // Extract version from IDs like "claude-opus-4-6", "claude-sonnet-4-6-20250514"
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

/** Format milliseconds as human-readable duration */
function formatDuration(ms) {
  if (!ms) return '0s';
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/** Parse the current session data from .claude.json */
function parseCurrentSession(project) {
  if (!project) return null;

  const modelUsage = project.lastModelUsage || {};
  const models = Object.entries(modelUsage).map(([id, data]) => ({
    id,
    name: friendlyModelName(id),
    inputTokens: data.inputTokens || 0,
    outputTokens: data.outputTokens || 0,
    cacheRead: data.cacheReadInputTokens || 0,
    cacheWrite: data.cacheCreationInputTokens || 0,
    cost: data.costUSD || 0,
  }));

  // Determine primary model (highest cost)
  const primaryModel = models.reduce(
    (best, m) => (m.cost > (best?.cost || 0) ? m : best),
    null
  );

  const totalInput = project.lastTotalInputTokens || 0;
  const totalOutput = project.lastTotalOutputTokens || 0;
  const cacheRead = project.lastTotalCacheReadInputTokens || 0;
  const cacheWrite = project.lastTotalCacheCreationInputTokens || 0;

  return {
    sessionId: project.lastSessionId || 'unknown',
    projectPath: project.path,
    cost: project.lastCost || 0,
    duration: formatDuration(project.lastDuration),
    durationMs: project.lastDuration || 0,
    primaryModel: primaryModel?.name || 'unknown',
    primaryModelId: primaryModel?.id || 'unknown',
    models,
    tokens: {
      input: totalInput,
      output: totalOutput,
      cacheRead,
      cacheWrite,
      total: totalInput + totalOutput + cacheRead + cacheWrite,
    },
    linesAdded: project.lastLinesAdded || 0,
    linesRemoved: project.lastLinesRemoved || 0,
    fps: project.lastFpsAverage || 0,
    performance: project.lastSessionMetrics || null,
    apiDuration: project.lastAPIDuration || 0,
    toolDuration: project.lastToolDuration || 0,
    lastActiveTs: project.lastSessionTimestamp || project.lastCostTimestamp || null,
  };
}

/** Parse stats-cache.json into dashboard-friendly format */
function parseStatsCache(stats) {
  if (!stats) return null;

  return {
    dailyActivity: stats.dailyActivity || [],
    dailyModelTokens: stats.dailyModelTokens || [],
    modelUsage: stats.modelUsage || {},
    totalSessions: stats.totalSessions || 0,
    totalMessages: stats.totalMessages || 0,
    longestSession: stats.longestSession || null,
    firstSessionDate: stats.firstSessionDate || null,
    hourCounts: stats.hourCounts || {},
  };
}

/** Parse all sessions from every project in .claude.json */
function parseAllSessions(claudeJson) {
  if (!claudeJson?.projects) return [];

  const sessions = [];
  for (const [path, proj] of Object.entries(claudeJson.projects)) {
    if (!proj.lastSessionId) continue;
    const session = parseCurrentSession({ path, ...proj });
    if (session) {
      session.projectName = basename(path);
      sessions.push(session);
    }
  }

  // Reverse insertion order — newest projects (appended last in .claude.json) appear first
  sessions.reverse();
  return sessions;
}

/** Main parse function — reads both files and returns full dashboard state.
 *  Returns null fields when files are unreadable (transient write in progress).
 *  store.update() guards against replacing good data with null/empty results.
 */
export async function parseAll() {
  const [claudeJson, statsCache] = await Promise.all([
    readJSON(CLAUDE_JSON),
    readJSON(STATS_CACHE),
  ]);

  const activeProject = findActiveProject(claudeJson);
  const currentSession = parseCurrentSession(activeProject);
  const sessions = claudeJson ? parseAllSessions(claudeJson) : null;
  const stats = parseStatsCache(statsCache);

  if (!claudeJson) {
    console.warn('[parser] .claude.json unreadable — returning null sessions (store will preserve existing)');
  }

  return {
    currentSession,
    sessions,
    stats,
    timestamp: Date.now(),
  };
}
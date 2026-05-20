/**
 * Live transcript aggregator.
 *
 * Walks ~/.claude/projects/<projectDir>/<sessionId>.jsonl and computes the same
 * shape of aggregates that ~/.claude/stats-cache.json holds — but live, from
 * the source of truth Anthropic writes per-session.
 *
 * Why this exists: stats-cache.json is written by Claude Code only when the
 * user opens the /usage panel in the TUI. Between openings, the cache goes
 * stale (verified 2026-05-20: cache was 43 days stale before /usage was
 * re-opened). The aggregator eliminates that failure mode by reading the
 * authoritative per-session JSONL stream directly.
 *
 * Output shape MATCHES parser.js:parseStatsCache so downstream consumers can
 * swap sources without code changes.
 *
 * Note on count definitions (may diverge from Anthropic's by 5-10% — close
 * enough for dashboard use, not authoritative for billing):
 * - messageCount per day  : count of (type=user | type=assistant) lines
 *                           whose timestamp falls on that ISO date
 * - sessionCount per day  : count of sessions whose FIRST timestamp falls on
 *                           that date ("new sessions today")
 * - toolCallCount per day : count of tool_use blocks inside assistant
 *                           message.content on that date
 */

import { readdir, readFile, stat } from 'fs/promises';
import { join, basename } from 'path';
import { EventEmitter } from 'events';

import { CLAUDE_PROJECTS_DIR } from './config.js';
import { estimateCost } from './cost-rates.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** ISO date (YYYY-MM-DD) for a given timestamp string */
function isoDate(ts) {
  if (!ts) return null;
  try {
    return new Date(ts).toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

/** Hour-of-day (0-23) for a given timestamp string */
function hourOfDay(ts) {
  if (!ts) return null;
  try {
    return new Date(ts).getUTCHours();
  } catch {
    return null;
  }
}

/** Count tool_use blocks in an assistant message.content array */
function countToolUseBlocks(content) {
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const block of content) {
    if (block && block.type === 'tool_use') n++;
  }
  return n;
}

/** Walk PROJECTS_DIR and return list of every *.jsonl file with absolute path */
async function listAllTranscripts(rootDir) {
  const out = [];
  let projectDirs;
  try {
    projectDirs = await readdir(rootDir, { withFileTypes: true });
  } catch {
    return out; // directory doesn't exist yet — empty aggregator
  }
  for (const ent of projectDirs) {
    if (!ent.isDirectory()) continue;
    const projDirPath = join(rootDir, ent.name);
    let files;
    try {
      files = await readdir(projDirPath);
    } catch {
      continue;
    }
    for (const f of files) {
      if (f.endsWith('.jsonl')) {
        out.push({ projectDir: ent.name, path: join(projDirPath, f), sessionId: f.replace(/\.jsonl$/, '') });
      }
    }
  }
  return out;
}

// ── Per-session parser ──────────────────────────────────────────────────────

/**
 * Parse one transcript file into a per-session aggregate.
 * Returns null if the file is empty / unreadable.
 */
async function parseTranscript(filePath, sessionId) {
  let buf;
  try {
    buf = await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  if (!buf) return null;

  const lines = buf.split('\n');
  let firstTs = null;
  let lastTs = null;
  let messageCount = 0;
  let toolCallCount = 0;
  const models = new Map(); // modelId -> {input,output,cacheRead,cacheWrite}
  let projectPath = null;

  for (const line of lines) {
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // corrupt line — skip
    }

    const ts = obj.timestamp;
    if (ts) {
      if (firstTs === null || ts < firstTs) firstTs = ts;
      if (lastTs === null || ts > lastTs) lastTs = ts;
    }
    if (!projectPath && obj.cwd) projectPath = obj.cwd;

    const type = obj.type;
    if (type === 'user' || type === 'assistant') {
      messageCount++;
      const msg = obj.message;
      if (msg) {
        if (type === 'assistant') {
          toolCallCount += countToolUseBlocks(msg.content);
        }
        const modelId = msg.model;
        const usage = msg.usage;
        if (modelId && usage) {
          const cur = models.get(modelId) || {
            input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
          };
          cur.input += usage.input_tokens || 0;
          cur.output += usage.output_tokens || 0;
          cur.cacheRead += usage.cache_read_input_tokens || 0;
          cur.cacheWrite += usage.cache_creation_input_tokens || 0;
          models.set(modelId, cur);
        }
      }
    }
  }

  if (firstTs === null && messageCount === 0) return null;

  // Compute cost across all models in this session
  let totalCost = 0;
  for (const [modelId, tok] of models) {
    totalCost += estimateCost(modelId, tok);
  }

  return {
    sessionId,
    projectPath,
    firstTs,
    lastTs,
    durationMs: firstTs && lastTs ? new Date(lastTs) - new Date(firstTs) : 0,
    messageCount,
    toolCallCount,
    models, // Map<modelId, {input,output,cacheRead,cacheWrite}>
    totalCost,
  };
}

// ── Aggregator ───────────────────────────────────────────────────────────────

export class AggregatesStore extends EventEmitter {
  constructor(rootDir = CLAUDE_PROJECTS_DIR) {
    super();
    this.rootDir = rootDir;
    this.sessions = new Map(); // sessionId -> per-session aggregate
    this.aggregates = this._empty();
    this.lastComputedAt = null;
    this.loading = false;
  }

  _empty() {
    return {
      totalSessions: 0,
      totalMessages: 0,
      totalCost: 0,
      firstSessionDate: null,
      longestSession: null,
      dailyActivity: [],
      dailyModelTokens: [],
      modelUsage: {},
      hourCounts: {},
    };
  }

  /** Walk all transcripts and rebuild aggregates from scratch */
  async loadAll() {
    if (this.loading) return;
    this.loading = true;
    const t0 = Date.now();
    try {
      const transcripts = await listAllTranscripts(this.rootDir);
      this.sessions.clear();
      for (const { sessionId, path } of transcripts) {
        const session = await parseTranscript(path, sessionId);
        if (session) this.sessions.set(sessionId, session);
      }
      this._recompute();
      const ms = Date.now() - t0;
      console.log(`[aggregates] loaded ${this.sessions.size} sessions from ${transcripts.length} transcripts in ${ms}ms`);
      this.emit('update', this.aggregates);
    } finally {
      this.loading = false;
    }
  }

  /** Recompute the rollup from current this.sessions map */
  _recompute() {
    const agg = this._empty();
    const byDate = new Map();        // date -> {messageCount, toolCallCount, sessionIdsStarted:Set}
    const tokensByDate = new Map();  // date -> {modelId -> totalTokens}
    const hours = new Map();         // 0-23 -> count
    const modelTotals = new Map();   // modelId -> {input,output,cacheRead,cacheWrite,cost}
    let longest = null;
    let earliest = null;

    for (const session of this.sessions.values()) {
      agg.totalSessions++;
      agg.totalMessages += session.messageCount;
      agg.totalCost += session.totalCost;

      if (session.firstTs) {
        if (earliest === null || session.firstTs < earliest) earliest = session.firstTs;
        const startDate = isoDate(session.firstTs);
        if (startDate) {
          let row = byDate.get(startDate);
          if (!row) {
            row = { messageCount: 0, toolCallCount: 0, sessionIdsStarted: new Set() };
            byDate.set(startDate, row);
          }
          row.sessionIdsStarted.add(session.sessionId);
        }
      }

      if (longest === null || session.durationMs > longest.durationMs) {
        longest = {
          sessionId: session.sessionId,
          durationMs: session.durationMs,
          projectPath: session.projectPath,
        };
      }

      // Daily message + hourly counts: need per-line ts, but we already collapsed
      // the lines into per-session stats. Use the session's firstTs date as the
      // bucketing date for messageCount + toolCallCount, and the firstTs hour
      // for hourCounts. This loses some intra-day resolution but matches how
      // stats-cache appears to aggregate ("new sessions today" semantics).
      const bucketDate = isoDate(session.firstTs);
      if (bucketDate) {
        const row = byDate.get(bucketDate) || {
          messageCount: 0, toolCallCount: 0, sessionIdsStarted: new Set(),
        };
        row.messageCount += session.messageCount;
        row.toolCallCount += session.toolCallCount;
        row.sessionIdsStarted.add(session.sessionId);
        byDate.set(bucketDate, row);
      }
      const h = hourOfDay(session.firstTs);
      if (h !== null) hours.set(h, (hours.get(h) || 0) + 1);

      for (const [modelId, tok] of session.models) {
        const cur = modelTotals.get(modelId) || {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
        };
        cur.input += tok.input;
        cur.output += tok.output;
        cur.cacheRead += tok.cacheRead;
        cur.cacheWrite += tok.cacheWrite;
        cur.cost += estimateCost(modelId, tok);
        modelTotals.set(modelId, cur);

        if (bucketDate) {
          let dayModels = tokensByDate.get(bucketDate);
          if (!dayModels) {
            dayModels = new Map();
            tokensByDate.set(bucketDate, dayModels);
          }
          const dayTotal = (dayModels.get(modelId) || 0) +
            tok.input + tok.output + tok.cacheRead + tok.cacheWrite;
          dayModels.set(modelId, dayTotal);
        }
      }
    }

    agg.firstSessionDate = earliest;
    agg.longestSession = longest;

    // dailyActivity: sort by date ascending
    const sortedDates = [...byDate.keys()].sort();
    agg.dailyActivity = sortedDates.map((date) => ({
      date,
      messageCount: byDate.get(date).messageCount,
      sessionCount: byDate.get(date).sessionIdsStarted.size,
      toolCallCount: byDate.get(date).toolCallCount,
    }));

    // dailyModelTokens
    agg.dailyModelTokens = sortedDates
      .filter((d) => tokensByDate.has(d))
      .map((date) => ({
        date,
        tokensByModel: Object.fromEntries(tokensByDate.get(date)),
      }));

    // modelUsage
    agg.modelUsage = Object.fromEntries(modelTotals);

    // hourCounts
    agg.hourCounts = Object.fromEntries(hours);

    this.aggregates = agg;
    this.lastComputedAt = Date.now();
  }

  /** Rebuild a single session from its transcript (used by incremental updates) */
  async reloadSession(sessionId, path) {
    const session = await parseTranscript(path, sessionId);
    if (session) {
      this.sessions.set(sessionId, session);
    } else {
      this.sessions.delete(sessionId);
    }
    this._recompute();
    this.emit('update', this.aggregates);
  }

  /** Drop a session from the aggregate (file was deleted) */
  removeSession(sessionId) {
    if (this.sessions.delete(sessionId)) {
      this._recompute();
      this.emit('update', this.aggregates);
    }
  }

  /** Current snapshot (matches parser.js:parseStatsCache shape + extras) */
  getAggregates() {
    return { ...this.aggregates, lastComputedAt: this.lastComputedAt };
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

export const aggregatesStore = new AggregatesStore();

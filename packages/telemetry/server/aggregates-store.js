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

/**
 * Walk PROJECTS_DIR two levels deep and return every subagent transcript:
 * <projDir>/<sessionId>/subagents/agent-*.jsonl
 */
async function listAllSubagentTranscripts(rootDir) {
  const out = [];
  let projectDirs;
  try {
    projectDirs = await readdir(rootDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const proj of projectDirs) {
    if (!proj.isDirectory()) continue;
    const projDirPath = join(rootDir, proj.name);
    let sessionDirs;
    try {
      sessionDirs = await readdir(projDirPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sess of sessionDirs) {
      if (!sess.isDirectory()) continue;
      const subDirPath = join(projDirPath, sess.name, 'subagents');
      let files;
      try {
        files = await readdir(subDirPath);
      } catch {
        continue; // no subagents/ child — normal
      }
      for (const f of files) {
        if (f.startsWith('agent-') && f.endsWith('.jsonl')) {
          out.push({
            projectDir: proj.name,
            parentSessionId: sess.name,
            agentId: f.replace(/^agent-/, '').replace(/\.jsonl$/, ''),
            path: join(subDirPath, f),
          });
        }
      }
    }
  }
  return out;
}

/**
 * Identify a subagent transcript path and decompose it.
 * Returns { projectDir, parentSessionId, agentId } or null if the path is a
 * regular session transcript. Tolerates both path separators (chokidar emits
 * forward slashes on Windows when given a forward-slash glob).
 */
export function decomposeSubagentPath(filePath) {
  const m = String(filePath).replace(/\\/g, '/').match(
    /([^/]+)\/([^/]+)\/subagents\/agent-([^/]+)\.jsonl$/
  );
  if (!m) return null;
  return { projectDir: m[1], parentSessionId: m[2], agentId: m[3] };
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
  const agentMeta = new Map(); // agentId -> {agentType,status,prompt,...} from toolUseResult records
  let projectPath = null;
  let firstUserText = null;

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

    // Agent-dispatch results live on user-type lines as toolUseResult.
    // They are the only place the parent records each subagent's type/status,
    // so capture them here for the cross-session subagent join.
    const tur = obj.toolUseResult;
    if (tur && typeof tur === 'object' && tur.agentId) {
      agentMeta.set(tur.agentId, {
        agentType: tur.agentType || null,
        status: tur.status || null,
        prompt: typeof tur.prompt === 'string' ? tur.prompt.slice(0, 300) : null,
        totalDurationMs: tur.totalDurationMs ?? null,
        totalToolUseCount: tur.totalToolUseCount ?? null,
      });
    }

    const type = obj.type;
    if (type === 'user' || type === 'assistant') {
      messageCount++;
      const msg = obj.message;
      if (msg) {
        if (type === 'assistant') {
          toolCallCount += countToolUseBlocks(msg.content);
        }
        if (type === 'user' && firstUserText === null) {
          // First user text = the dispatch prompt in subagent transcripts.
          // Fallback identity for agents whose parent meta is unavailable.
          if (typeof msg.content === 'string') {
            firstUserText = msg.content.slice(0, 300);
          } else if (Array.isArray(msg.content)) {
            const textBlock = msg.content.find((b) => b && b.type === 'text' && typeof b.text === 'string');
            if (textBlock) firstUserText = textBlock.text.slice(0, 300);
          }
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
    agentMeta, // Map<agentId, {agentType,status,prompt,totalDurationMs,totalToolUseCount}>
    firstUserText,
  };
}

// ── Aggregator ───────────────────────────────────────────────────────────────

export class AggregatesStore extends EventEmitter {
  constructor(rootDir = CLAUDE_PROJECTS_DIR) {
    super();
    this.rootDir = rootDir;
    this.sessions = new Map(); // sessionId -> per-session aggregate
    this.subagents = new Map(); // agentId -> per-agent aggregate (from subagents/ transcripts)
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
      for (const { sessionId, path, projectDir } of transcripts) {
        const session = await parseTranscript(path, sessionId);
        if (session) {
          session.projectDir = projectDir;
          this.sessions.set(sessionId, session);
        }
      }

      const agentTranscripts = await listAllSubagentTranscripts(this.rootDir);
      this.subagents.clear();
      for (const { agentId, path, projectDir, parentSessionId } of agentTranscripts) {
        const agent = await parseTranscript(path, agentId);
        if (agent) {
          agent.projectDir = projectDir;
          agent.parentSessionId = parentSessionId;
          this.subagents.set(agentId, agent);
        }
      }

      this._recompute();
      const ms = Date.now() - t0;
      console.log(`[aggregates] loaded ${this.sessions.size} sessions + ${this.subagents.size} subagents from ${transcripts.length + agentTranscripts.length} transcripts in ${ms}ms`);
      this.emit('update', this.aggregates);
      this.emit('subagents-update', this.getSubagents());
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
  async reloadSession(sessionId, path, projectDir = null) {
    const session = await parseTranscript(path, sessionId);
    if (session) {
      session.projectDir = projectDir || this.sessions.get(sessionId)?.projectDir || null;
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

  /** Rebuild a single subagent from its transcript (incremental updates) */
  async reloadSubagent(agentId, path, projectDir = null, parentSessionId = null) {
    const agent = await parseTranscript(path, agentId);
    if (agent) {
      const prev = this.subagents.get(agentId);
      agent.projectDir = projectDir || prev?.projectDir || null;
      agent.parentSessionId = parentSessionId || prev?.parentSessionId || null;
      this.subagents.set(agentId, agent);
    } else {
      this.subagents.delete(agentId);
    }
    this.emit('subagents-update', this.getSubagents());
  }

  /** Drop a subagent (file was deleted) */
  removeSubagent(agentId) {
    if (this.subagents.delete(agentId)) {
      this.emit('subagents-update', this.getSubagents());
    }
  }

  /** Current snapshot (matches parser.js:parseStatsCache shape + extras) */
  getAggregates() {
    return { ...this.aggregates, lastComputedAt: this.lastComputedAt };
  }

  /**
   * Per-session detail list for the Sessions surface.
   * Sorted by last activity, newest first.
   */
  getSessions() {
    const sessions = [...this.sessions.values()].map((s) => ({
      sessionId: s.sessionId,
      projectDir: s.projectDir || null,
      projectPath: s.projectPath,
      firstTs: s.firstTs,
      lastTs: s.lastTs,
      durationMs: s.durationMs,
      messageCount: s.messageCount,
      toolCallCount: s.toolCallCount,
      totalCost: s.totalCost,
      models: serializeModels(s.models),
      primaryModel: primaryModelOf(s.models),
    }));
    sessions.sort((a, b) => String(b.lastTs || '').localeCompare(String(a.lastTs || '')));
    return { sessions, total: sessions.length, lastComputedAt: this.lastComputedAt };
  }

  /**
   * Cross-session subagent list + per-type leaderboard for the Subagents
   * surface. Type/status/prompt are joined from the parent session's
   * toolUseResult records when available; the agent's own first user message
   * is the prompt fallback.
   */
  getSubagents() {
    const agents = [...this.subagents.values()].map((a) => {
      const meta = this.sessions.get(a.parentSessionId)?.agentMeta?.get(a.sessionId) || null;
      let totalTokens = 0;
      for (const tok of a.models.values()) {
        totalTokens += tok.input + tok.output + tok.cacheRead + tok.cacheWrite;
      }
      return {
        agentId: a.sessionId, // parseTranscript stores the id it was given
        parentSessionId: a.parentSessionId || null,
        projectDir: a.projectDir || null,
        agentType: meta?.agentType || null,
        status: meta?.status || null,
        prompt: meta?.prompt || a.firstUserText || null,
        firstTs: a.firstTs,
        lastTs: a.lastTs,
        durationMs: meta?.totalDurationMs ?? a.durationMs,
        messageCount: a.messageCount,
        toolCallCount: meta?.totalToolUseCount ?? a.toolCallCount,
        totalCost: a.totalCost,
        totalTokens,
        models: serializeModels(a.models),
        primaryModel: primaryModelOf(a.models),
      };
    });
    agents.sort((a, b) => String(b.lastTs || '').localeCompare(String(a.lastTs || '')));

    const byTypeMap = new Map();
    for (const a of agents) {
      const key = a.agentType || '(unknown)';
      let row = byTypeMap.get(key);
      if (!row) {
        row = { agentType: key, runs: 0, totalCost: 0, totalTokens: 0, totalDurationMs: 0, fails: 0, modelTokens: new Map() };
        byTypeMap.set(key, row);
      }
      row.runs++;
      row.totalCost += a.totalCost;
      row.totalTokens += a.totalTokens;
      row.totalDurationMs += a.durationMs || 0;
      if (a.status && a.status !== 'completed') row.fails++;
      if (a.primaryModel) {
        row.modelTokens.set(a.primaryModel, (row.modelTokens.get(a.primaryModel) || 0) + a.totalTokens);
      }
    }
    const byType = [...byTypeMap.values()].map((r) => ({
      agentType: r.agentType,
      runs: r.runs,
      totalCost: r.totalCost,
      totalTokens: r.totalTokens,
      avgDurationMs: r.runs ? Math.round(r.totalDurationMs / r.runs) : 0,
      fails: r.fails,
      topModel: [...r.modelTokens.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null,
    }));
    byType.sort((a, b) => b.totalCost - a.totalCost);

    return { agents, byType, totalAgents: agents.length, lastComputedAt: this.lastComputedAt };
  }
}

/** Map<modelId, tokens> → plain object */
function serializeModels(models) {
  const out = {};
  for (const [id, tok] of models) out[id] = { ...tok };
  return out;
}

/** Model with the most total tokens in this transcript */
function primaryModelOf(models) {
  let best = null;
  let bestTokens = -1;
  for (const [id, tok] of models) {
    const t = tok.input + tok.output + tok.cacheRead + tok.cacheWrite;
    if (t > bestTokens) {
      best = id;
      bestTokens = t;
    }
  }
  return best;
}

// ── Singleton ────────────────────────────────────────────────────────────────

export const aggregatesStore = new AggregatesStore();

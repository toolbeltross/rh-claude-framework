import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { createHash } from 'crypto';
import { FAILURE_LOG_PATH, MAX_FAILURE_CACHE, MAX_FAILURE_QUERY_RESULTS } from './config.js';

/**
 * D1 — Classify an error string into a coarse errorClass.
 * Used to group failures on the dashboard so you can see "3 ENOENTs" at a glance
 * instead of scanning raw messages. Best-effort: falls back to 'other'.
 */
export function classifyError(error, eventType) {
  if (eventType === 'subagent_orphaned') return 'orphan';
  if (eventType === 'validation_block') return 'validation';
  if (eventType === 'validation_suggest') return 'suggestion';
  if (eventType === 'config_change') return 'config';
  const msg = String(error || '').toLowerCase();
  if (!msg) return 'other';
  if (msg.includes('enoent') || msg.includes('no such file') || msg.includes('does not exist') || msg.includes('not found')) return 'not_found';
  if (msg.includes('eacces') || msg.includes('eperm') || msg.includes('permission denied') || msg.includes('access denied')) return 'permission';
  if (msg.includes('256kb') || msg.includes('size limit') || msg.includes('too large') || msg.includes('exceeds')) return 'size_limit';
  if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('etimedout')) return 'timeout';
  if (msg.includes('econnrefused') || msg.includes('enetunreach') || msg.includes('connection') && msg.includes('refused')) return 'network';
  return 'other';
}

/**
 * D2 — Hash a tool invocation into a stable string so repeat invocations
 * of the same tool with the same input can be detected. Uses sha1 of the
 * JSON-serialized input (stable over object key order? no — but good enough
 * for detecting obvious retry loops).
 */
export function hashToolInvocation(toolName, toolInput) {
  const payload = `${toolName || ''}::${JSON.stringify(toolInput ?? '')}`;
  return createHash('sha1').update(payload).digest('hex').slice(0, 16);
}

/**
 * Persistent failure store backed by a JSONL file.
 *
 * - Append-only writes (safe on Windows/OneDrive)
 * - In-memory cache of the last N records for fast queries
 * - Loaded from disk on server start so data survives restarts
 */
export class FailureStore {
  constructor(filePath = FAILURE_LOG_PATH) {
    this.filePath = filePath;
    this.cache = []; // most recent last
    this.maxCache = MAX_FAILURE_CACHE;
    /** @type {((record: object) => void) | null} */
    this.onAppend = null; // callback for store integration
  }

  /** Load existing JSONL file into memory cache */
  load() {
    if (!existsSync(this.filePath)) {
      console.log(`[failure-store] No existing file at ${this.filePath} — starting fresh`);
      return;
    }
    try {
      const content = readFileSync(this.filePath, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const record = JSON.parse(line);
          // D1 — backfill errorClass on historical records missing it
          if (!record.errorClass) {
            record.errorClass = classifyError(record.error, record.eventType);
          }
          this.cache.push(record);
        } catch {
          // skip malformed lines
        }
      }
      // Keep only the tail
      if (this.cache.length > this.maxCache) {
        this.cache = this.cache.slice(-this.maxCache);
      }
      console.log(`[failure-store] Loaded ${this.cache.length} failure records`);
    } catch (err) {
      console.error(`[failure-store] Error loading: ${err.message}`);
    }
  }

  /** Append a failure record to JSONL and in-memory cache */
  append({ sessionId, toolName, eventType, error, toolInput, cwd, durationMs, promptId, promptSnippet, estimatedCost }) {
    const errorStr = typeof error === 'string' ? error.slice(0, 2000) : String(error || 'Unknown error');
    const errorClass = classifyError(errorStr, eventType);

    // D2 — Retry detection. Scan the trailing 60 seconds of cache for any
    // prior failure with the same tool + input hash for this session.
    // Only detect retries within execution event types (not config/suggest).
    const invocationHash = hashToolInvocation(toolName, toolInput);
    const isExecutionFailure = !['config_change', 'validation_suggest', 'subagent_orphaned'].includes(eventType);
    let retryOf = null;
    let retrySequence = 0;
    if (isExecutionFailure) {
      const since = Date.now() - 60_000;
      for (let i = this.cache.length - 1; i >= 0; i--) {
        const prev = this.cache[i];
        if (prev.timestamp < since) break;
        if (prev.sessionId !== (sessionId || '')) continue;
        if (prev.invocationHash !== invocationHash) continue;
        // Found the most recent prior invocation within the window
        retryOf = prev.id;
        retrySequence = (prev.retrySequence || 0) + 1;
        break;
      }
    }

    const record = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      isoTime: new Date().toISOString(),
      sessionId: sessionId || '',
      toolName: toolName || 'unknown',
      eventType: eventType || 'post_tool_use_failure',
      error: errorStr,
      errorClass, // D1
      toolInput: toolInput ?? null,
      invocationHash, // D2
      retryOf, // D2 — null for originals, prior id for retries
      retrySequence, // D2 — 0 for originals, 1+ for retries
      cwd: cwd || '',
      durationMs: durationMs ?? null,
      promptId: promptId || null, // D3
      promptSnippet: promptSnippet ? String(promptSnippet).slice(0, 200) : null, // D3
      estimatedCost: typeof estimatedCost === 'number' ? estimatedCost : null, // D4
    };

    // Persist to disk
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      appendFileSync(this.filePath, JSON.stringify(record) + '\n', 'utf-8');
    } catch (err) {
      console.error(`[failure-store] Write error: ${err.message}`);
    }

    // Update cache
    this.cache.push(record);
    if (this.cache.length > this.maxCache) {
      this.cache = this.cache.slice(-this.maxCache);
    }

    // Notify listener (store.js emits event)
    if (this.onAppend) this.onAppend(record);

    return record;
  }

  /** Query failures with optional filters */
  query({ sessionId, toolName, since, limit } = {}) {
    let results = this.cache;

    if (sessionId) {
      results = results.filter(r => r.sessionId === sessionId);
    }
    if (toolName) {
      results = results.filter(r => r.toolName === toolName);
    }
    if (since) {
      results = results.filter(r => r.timestamp >= since);
    }

    // Most recent first
    results = [...results].reverse();

    const max = Math.min(limit || MAX_FAILURE_QUERY_RESULTS, MAX_FAILURE_QUERY_RESULTS);
    return results.slice(0, max);
  }

  /** Frequency analysis across cached failures */
  getPatterns() {
    const byTool = {};
    const byError = {};
    const bySession = {};
    const byClass = {}; // D1
    let totalRetries = 0; // D2

    for (const r of this.cache) {
      byTool[r.toolName] = (byTool[r.toolName] || 0) + 1;

      // Normalize error messages (first 100 chars) for grouping
      const errKey = (r.error || '').slice(0, 100);
      if (errKey) {
        byError[errKey] = (byError[errKey] || 0) + 1;
      }

      if (r.sessionId) {
        bySession[r.sessionId] = (bySession[r.sessionId] || 0) + 1;
      }

      const cls = r.errorClass || classifyError(r.error, r.eventType);
      byClass[cls] = (byClass[cls] || 0) + 1;

      if (r.retrySequence > 0) totalRetries++;
    }

    return {
      byTool,
      byError,
      bySession,
      byClass,
      totalRetries,
      total: this.cache.length,
    };
  }

  /**
   * D4 — Top N failures by estimated cost (descending), from the in-memory cache.
   * Useful for "what are my most expensive recent failures" ranking.
   */
  getTopCostFailures(n = 3, since = Date.now() - 24 * 60 * 60 * 1000) {
    const ranked = this.cache
      .filter((r) => r.timestamp >= since && typeof r.estimatedCost === 'number' && r.estimatedCost > 0)
      .sort((a, b) => (b.estimatedCost || 0) - (a.estimatedCost || 0));
    return ranked.slice(0, n);
  }

  /** Summary digest for a time period */
  getDigest(since = Date.now() - 24 * 60 * 60 * 1000) {
    const recent = this.cache.filter(r => r.timestamp >= since);
    const sessions = new Set(recent.map(r => r.sessionId).filter(Boolean));

    // Top failing tool
    const toolCounts = {};
    for (const r of recent) {
      toolCounts[r.toolName] = (toolCounts[r.toolName] || 0) + 1;
    }
    const topTool = Object.entries(toolCounts).sort((a, b) => b[1] - a[1])[0] || null;

    // Top error
    const errCounts = {};
    for (const r of recent) {
      const key = (r.error || '').slice(0, 100);
      if (key) errCounts[key] = (errCounts[key] || 0) + 1;
    }
    const topError = Object.entries(errCounts).sort((a, b) => b[1] - a[1])[0] || null;

    return {
      since: new Date(since).toISOString(),
      totalFailures: recent.length,
      uniqueSessions: sessions.size,
      topFailingTool: topTool ? { name: topTool[0], count: topTool[1] } : null,
      topError: topError ? { message: topError[0], count: topError[1] } : null,
      byTool: toolCounts,
      recentFailures: recent.slice(-10).reverse(),
    };
  }

  /** Get the N most recent failures */
  getRecentFailures(n = 20) {
    return this.cache.slice(-n).reverse();
  }
}
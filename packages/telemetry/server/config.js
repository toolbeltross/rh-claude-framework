/**
 * Centralized configuration for rh-telemetry.
 *
 * All hardcoded values live here. Import named constants from this module
 * instead of scattering magic numbers across the codebase.
 *
 * Environment variable overrides are applied where noted.
 */
import { join } from 'path';
import { homedir } from 'os';

// ── Server ───────────────────────────────────────────────────────────────────

export const PORT = parseInt(process.env.RH_TELEMETRY_PORT || process.env.PORT, 10) || 7890;
// Bind to loopback by default — the dashboard exposes session prompts/costs/
// transcripts and unauthenticated write endpoints, so it must not be reachable
// from the LAN unless the user explicitly opts in (RH_TELEMETRY_HOST=0.0.0.0).
export const HOST = process.env.RH_TELEMETRY_HOST || '127.0.0.1';
export const BASE_URL = `http://localhost:${PORT}`;
export const WS_URL = `ws://localhost:${PORT}/ws`;
export const VITE_DEV_PORT = 5173;

// ── File Paths ───────────────────────────────────────────────────────────────

const HOME = process.env.HOME || process.env.USERPROFILE || homedir();

export const CLAUDE_JSON_PATH = join(HOME, '.claude.json');
export const STATS_CACHE_PATH = join(HOME, '.claude', 'stats-cache.json');
export const CREDENTIALS_PATH = join(HOME, '.claude', '.credentials.json');
export const CLAUDE_PROJECTS_DIR = join(HOME, '.claude', 'projects');

// ── Limits ───────────────────────────────────────────────────────────────────

export const MAX_TOOL_EVENTS = 200;
export const MAX_TURN_HISTORY = 50;
export const MAX_SUBAGENT_HISTORY = 50;
export const MAX_PROMPT_HISTORY = 10;
export const MAX_CONTEXT_HISTORY = 20;
export const DEFAULT_CONTEXT_WINDOW_SIZE = 200_000;
export const EXTENDED_CONTEXT_WINDOW_SIZE = 1_000_000;

// ── Pruning ──────────────────────────────────────────────────────────────────

/** Stale session prune threshold (idle terminals may still be live) */
export const STALE_SESSION_MS = 2 * 60 * 60 * 1000; // 2 hours

/** Force-refresh prune threshold (aggressive, for manual refresh button) */
export const FORCE_REFRESH_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Subagent orphan threshold. If an _activeSubagents entry has had no tool
 * event (or never had one, measured from startedAt) in this long, it's
 * considered orphaned — moved to history with status:'orphaned' and logged
 * to the failure store. Catches subagents where SubagentStop never fires
 * due to compaction, parent-turn interrupt, or dropped hooks.
 * Override via RH_TELEMETRY_SUBAGENT_ORPHAN_MS env var.
 */
export const SUBAGENT_ORPHAN_MS = parseInt(process.env.RH_TELEMETRY_SUBAGENT_ORPHAN_MS, 10) || 10 * 60 * 1000; // 10 minutes

// ── Polling / Timing ─────────────────────────────────────────────────────────

/** chokidar polling interval for .claude.json / stats-cache.json */
export const FILE_POLL_INTERVAL_MS = 3000;

/** chokidar awaitWriteFinish stabilityThreshold */
export const WRITE_STABILITY_MS = 1000;

/** chokidar awaitWriteFinish pollInterval */
export const WRITE_POLL_MS = 500;

/**
 * Faster constants for append-only JSONL watchers (transcripts, oversight
 * events). Their readers tolerate a partially-written last line — the
 * oversight tail reader only consumes complete lines and the transcript
 * parser skips unparseable lines — so the conservative 1s write-stability
 * damping above is unnecessary latency for these sources. ~/.claude is not
 * under OneDrive, so 1s stat-polling is cheap.
 */
export const JSONL_POLL_INTERVAL_MS = 1000;
export const JSONL_STABILITY_MS = 250;
export const JSONL_WRITE_POLL_MS = 100;

/** WebSocket heartbeat ping interval */
export const WS_HEARTBEAT_MS = 30_000;

/** Statusline POST timeout */
export const STATUSLINE_TIMEOUT_MS = 1200;

/** Hook forwarder POST timeout */
export const HOOK_FORWARDER_TIMEOUT_MS = 1500;

// ── Plan Detector ────────────────────────────────────────────────────────────

/** How often to re-read credentials file */
export const CREDENTIALS_POLL_MS = 5 * 60 * 1000;

/** How often to poll the Anthropic usage API */
export const USAGE_POLL_MS = 60 * 1000;

/** Maximum backoff for usage polling on errors */
export const MAX_POLL_INTERVAL_MS = 5 * 60 * 1000;

/** Claude Code OAuth client ID (public, not a secret) */
export const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

// ── Failure Store ────────────────────────────────────────────────────────────

/** Persistent JSONL log of tool failures, validation blocks, and bash errors */
export const FAILURE_LOG_PATH = join(HOME, '.claude', 'telemetry-failures.jsonl');

/** Maximum failure records kept in memory (tail of the JSONL file) */
export const MAX_FAILURE_CACHE = 1000;

/** Maximum results returned by failure query endpoints */
export const MAX_FAILURE_QUERY_RESULTS = 200;

// ── Hook Performance ────────────────────────────────────────────────────────

/** Append-only JSONL log of per-hook-invocation latency records */
export const HOOK_PERF_LOG_PATH = join(HOME, '.claude', 'hook-perf.jsonl');

/** Maximum hook perf records kept in memory */
export const MAX_HOOK_PERF_CACHE = 5000;

/** Maximum results returned by hook-perf query endpoints */
export const MAX_HOOK_PERF_QUERY_RESULTS = 200;

// ── Supervisory Log ──────────────────────────────────────────────────────────

/**
 * Append-only markdown log of per-turn progress entries and failure digests.
 * Lives in the user's home .claude directory (not the repo) because the
 * hook-forwarder runs for every Claude Code session on this machine, not
 * just the rh-telemetry project's own sessions — so the log's true
 * scope is user-global, matching FAILURE_LOG_PATH above.
 */
export const SUPERVISORY_LOG_PATH = join(HOME, '.claude', 'telemetry-supervisory-log.md');

/**
 * Optional second target for the same per-turn progress entries. When the env
 * var `OVERSIGHT_LOG_PATH` is set to an absolute file path, hook-forwarder
 * dual-writes each Stop-hook entry to both SUPERVISORY_LOG_PATH (always) and
 * this path (best-effort). Used to keep an external oversight-system log in
 * sync with the local telemetry log without coupling the telemetry package
 * to any particular consumer. Missing/offline target silently skipped.
 */
export const OVERSIGHT_LOG_PATH = process.env.OVERSIGHT_LOG_PATH || null;

/** Failure alerting: number of failures for same tool+session to trigger alert */
export const FAILURE_ALERT_THRESHOLD = 3;

/** Failure alerting: sliding window duration */
export const FAILURE_ALERT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

// ── Idle Detection ───────────────────────────────────────────────────────────

/** Marker file written by Stop hook, read by statusline, cleared by UserPromptSubmit */
export const IDLE_MARKER_PATH = join(HOME, '.claude', '.telemetry-idle');

// ── StatusLine Integrity ─────────────────────────────────────────────────────

/** Append-only log of statusLine configuration changes (restore point) */
export const STATUSLINE_HISTORY_PATH = join(HOME, '.claude', 'telemetry-statusline-history.jsonl');

/** ~/.claude/settings.json path (watched by statusline-watcher) */
export const CLAUDE_SETTINGS_PATH = join(HOME, '.claude', 'settings.json');

/**
 * Stall detection threshold: if tool events are flowing (≥3 since last status
 * post) but no statusLine-sourced POSTs have arrived for this long, mark the
 * statusLine as stalled. Guards against runtime failures where the config
 * looks correct but POSTs aren't reaching the server.
 */
export const STATUS_LINE_STALL_MS = 120_000; // 2 minutes

/** Minimum tool events since last status post before stall check fires */
export const STATUS_LINE_STALL_MIN_TOOLS = 3;

// ── Convenience helpers ──────────────────────────────────────────────────────

export function apiUrl(path = '') {
  return `${BASE_URL}${path}`;
}

/**
 * Resolve actual context window size, accounting for extended-context models.
 * Returns the reported size if provided, detects 1M from model name or token
 * overshoot, or returns null if truly unknown. Never guesses.
 * Env override: CLAUDE_CONTEXT_WINDOW_SIZE=1000000
 */
export function resolveContextWindowSize(reportedSize, modelDisplayName, totalInputTokens) {
  // Env override (most reliable for known plan tier)
  const envSize = parseInt(process.env.CLAUDE_CONTEXT_WINDOW_SIZE, 10);
  if (envSize > 0) return envSize;
  // Model name detection — matches "Opus 4.6 (1M context)" AND "claude-opus-4-7[1m]".
  // Either the literal "1m context" phrase OR the "[1m]" bracket-suffix convention.
  if (modelDisplayName && /1m\s*context|\[1m\]/i.test(modelDisplayName)) {
    return EXTENDED_CONTEXT_WINDOW_SIZE;
  }
  // Auto-detect: if tokens exceed reported size, real limit must be higher
  if (reportedSize && totalInputTokens && totalInputTokens > reportedSize) {
    return EXTENDED_CONTEXT_WINDOW_SIZE;
  }
  // Return what was reported, or null if nothing was reported
  return reportedSize ?? null;
}
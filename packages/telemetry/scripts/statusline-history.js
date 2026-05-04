/**
 * Append-only history log for statusLine rewrites.
 * Used as the restore point — every rewrite records the previous command,
 * the new command, the classifier verdict that triggered it, and the action.
 *
 * File: ~/.claude/telemetry-statusline-history.jsonl
 */
import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { STATUSLINE_HISTORY_PATH } from '../server/config.js';

/**
 * Append a single history entry.
 *
 * @param {object} entry
 * @param {string} entry.action - 'install' | 'upgrade' | 'replace' | 'wrap' | 'skip' | 'revert'
 * @param {string} entry.from - Previous statusLine.command (empty if missing)
 * @param {string} entry.to - New statusLine.command (empty if skip)
 * @param {string} entry.classifier - Class from classifyStatusLine
 * @param {string|null} entry.reason - Human-readable reason
 */
export function appendHistoryEntry({ action, from, to, classifier, reason }) {
  const record = {
    ts: Date.now(),
    tsIso: new Date().toISOString(),
    action,
    from: from || '',
    to: to || '',
    classifier: classifier || 'unknown',
    reason: reason || null,
  };
  try {
    mkdirSync(dirname(STATUSLINE_HISTORY_PATH), { recursive: true });
    appendFileSync(STATUSLINE_HISTORY_PATH, JSON.stringify(record) + '\n', 'utf-8');
    return true;
  } catch (err) {
    console.error(`[statusline-history] Failed to append: ${err.message}`);
    return false;
  }
}

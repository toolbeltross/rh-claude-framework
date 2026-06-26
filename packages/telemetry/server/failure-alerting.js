/**
 * Sliding window failure alerter.
 *
 * Tracks failures per session+tool. When the same tool fails >= threshold
 * times within the alert window, returns an alert object for broadcasting.
 */
import { FAILURE_ALERT_THRESHOLD, FAILURE_ALERT_WINDOW_MS } from './config.js';

export class FailureAlerter {
  constructor(threshold = FAILURE_ALERT_THRESHOLD, windowMs = FAILURE_ALERT_WINDOW_MS) {
    this.threshold = threshold;
    this.windowMs = windowMs;
    /** @type {Map<string, number[]>} key = `${sessionId}:${toolName}` → timestamps */
    this.windows = new Map();
  }

  /**
   * Record a failure and check if the alert threshold is met.
   * @param {string} sessionId
   * @param {string} toolName
   * @param {number} [timestamp] - defaults to Date.now()
   * @returns {{ alert: boolean, count: number, toolName: string, sessionId: string, threshold: number } | null}
   *   Returns alert object if threshold met, null otherwise.
   */
  check(sessionId, toolName, timestamp = Date.now()) {
    const key = `${sessionId}:${toolName}`;
    const cutoff = timestamp - this.windowMs;

    let timestamps = this.windows.get(key);
    if (!timestamps) {
      timestamps = [];
      this.windows.set(key, timestamps);
    }

    // Add current failure
    timestamps.push(timestamp);

    // Prune entries outside the window
    const pruned = timestamps.filter(ts => ts > cutoff);
    this.windows.set(key, pruned);

    if (pruned.length >= this.threshold) {
      return {
        alert: true,
        count: pruned.length,
        toolName,
        sessionId,
        threshold: this.threshold,
      };
    }

    return null;
  }

  /** Get current threshold configuration */
  getConfig() {
    return {
      threshold: this.threshold,
      windowMs: this.windowMs,
    };
  }
}

/**
 * Watches ~/.claude/settings.json for changes and re-classifies the statusLine
 * configuration whenever it changes. Pushes the result into the store so the
 * dashboard can surface a banner when the config degrades.
 *
 * Self-write guard: classification result is compared against current store
 * state — if identical (class + scriptPath + command), no event is emitted.
 * This handles the case where we rewrite settings.json ourselves (via
 * repair-statusline) without triggering a spurious broadcast loop.
 */
import chokidar from 'chokidar';
import { classifyStatusLineFromFile } from '../scripts/statusline-classifier.js';
import { CLAUDE_SETTINGS_PATH } from './config.js';
import { store } from './store.js';

let watcher = null;

/** Run classification once and push result into store (does not emit if unchanged). */
export function classifyAndUpdate() {
  const result = classifyStatusLineFromFile(CLAUDE_SETTINGS_PATH);
  store.updateStatusLineState({
    class: result.class,
    command: result.command,
    scriptPath: result.scriptPath,
    reason: result.reason,
  });
  return result;
}

/** Start the chokidar watcher. Idempotent — calling twice is a no-op. */
export function startStatusLineWatcher() {
  if (watcher) return watcher;

  // Initial classification at boot (Layer A)
  const initial = classifyAndUpdate();
  console.log(`[statusline] boot classification: ${initial.class}${initial.reason ? ` (${initial.reason})` : ''}`);

  // File watch (Layer B) — small file, short stability window
  watcher = chokidar.watch(CLAUDE_SETTINGS_PATH, {
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 500,
      pollInterval: 100,
    },
    usePolling: true,
    interval: 1000,
  });

  watcher.on('change', () => {
    const result = classifyAndUpdate();
    const state = store.data.statusLineState;
    // Only log if class actually changed (updateStatusLineState handles emit gating)
    console.log(`[statusline] settings.json changed — class=${result.class}${result.reason ? ` (${result.reason})` : ''}`);
  });

  watcher.on('error', (err) => {
    console.error(`[statusline] watcher error: ${err.message}`);
  });

  return watcher;
}

export function stopStatusLineWatcher() {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
}

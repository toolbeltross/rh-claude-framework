import chokidar from 'chokidar';
import { parseAll, CLAUDE_JSON, STATS_CACHE } from './parser.js';
import { store } from './store.js';
import { FILE_POLL_INTERVAL_MS, WRITE_STABILITY_MS, WRITE_POLL_MS } from './config.js';

let watcher = null;

export function startWatchers() {
  // Initial parse
  parseAll().then((data) => {
    store.update(data);
    console.log('[watchers] Initial data loaded');
  }).catch((err) => {
    console.error('[watchers] Initial parse error:', err.message);
  });

  // Watch both files with polling (reliable on Windows + OneDrive)
  watcher = chokidar.watch([CLAUDE_JSON, STATS_CACHE], {
    usePolling: true,
    interval: FILE_POLL_INTERVAL_MS,
    awaitWriteFinish: {
      stabilityThreshold: WRITE_STABILITY_MS,
      pollInterval: WRITE_POLL_MS,
    },
  });

  watcher.on('change', (path) => {
    console.log(`[watchers] File changed: ${path}`);
    parseAll().then((data) => {
      store.update(data);
    }).catch((err) => {
      console.error('[watchers] Parse error on change:', err.message);
    });
  });

  console.log('[watchers] Watching .claude.json and stats-cache.json');
}

export function stopWatchers() {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
}
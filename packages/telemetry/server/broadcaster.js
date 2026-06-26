import { WebSocketServer } from 'ws';
import { store } from './store.js';
import { aggregatesStore } from './aggregates-store.js';
import { WS_HEARTBEAT_MS } from './config.js';

let wss = null;

export function startBroadcaster(server) {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    console.log('[ws] Client connected');
    ws.isAlive = true;

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    // Send full snapshot on connect
    ws.send(JSON.stringify({
      type: 'snapshot',
      data: store.getSnapshot(),
    }));

    ws.on('close', () => {
      console.log('[ws] Client disconnected');
    });
  });

  // Heartbeat: ping periodically, terminate stale connections
  const heartbeat = setInterval(() => {
    if (!wss) return;
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, WS_HEARTBEAT_MS);

  // Broadcast data updates to all connected clients
  store.on('update', (changed) => {
    broadcast({
      type: 'update',
      data: changed,
    });
  });

  // Broadcast transcript-aggregates updates (replaces stale stats-cache.json
  // reads for any v2 surface that wants live totals)
  aggregatesStore.on('update', (aggregates) => {
    broadcast({
      type: 'aggregatesUpdated',
      data: aggregates,
    });
  });

  // Broadcast subagent-aggregates updates (cross-session Subagents surface).
  // Payload deliberately omitted — the full list is heavy and the client
  // refetches GET /api/subagents on this signal.
  aggregatesStore.on('subagents-update', () => {
    broadcast({
      type: 'subagentsAggUpdated',
      data: { ts: Date.now() },
    });
  });

  // Broadcast live session updates
  store.on('liveSession', (data) => {
    broadcast({
      type: 'liveSession',
      data,
    });
  });

  // Broadcast tool events
  store.on('toolEvent', (event) => {
    broadcast({
      type: 'toolEvent',
      data: event,
    });
  });

  // Broadcast turn end events
  store.on('turnEnd', (data) => {
    broadcast({
      type: 'turnEnd',
      data,
    });
  });

  // Broadcast compact events
  store.on('compactEvent', (data) => {
    broadcast({
      type: 'compactEvent',
      data,
    });
  });

  // Broadcast subagent updates
  store.on('subagentUpdate', (data) => {
    broadcast({
      type: 'subagentUpdate',
      data,
    });
  });

  // Broadcast prompt updates
  store.on('promptUpdate', (data) => {
    broadcast({
      type: 'promptUpdate',
      data,
    });
  });

  // Broadcast failure events
  store.on('failureEvent', (data) => {
    broadcast({
      type: 'failureEvent',
      data,
    });
  });

  // Broadcast failure alert events (threshold exceeded)
  store.on('failureAlert', (data) => {
    broadcast({
      type: 'failureAlert',
      data,
    });
  });

  // Broadcast plan info updates (plan type, display mode, usage utilization)
  store.on('planInfo', (data) => {
    broadcast({
      type: 'planInfo',
      data,
    });
  });

  // Broadcast statusLine integrity state changes (class change, stall toggle)
  store.on('statusLineState', (data) => {
    broadcast({
      type: 'statusLineState',
      data,
    });
  });

  // Broadcast config-change events (settings.json modifications)
  store.on('configChange', (data) => {
    broadcast({
      type: 'configChange',
      data,
    });
  });

  // Broadcast task-completed events
  store.on('taskCompleted', (data) => {
    broadcast({
      type: 'taskCompleted',
      data,
    });
  });

  // Broadcast forced-continuation events (Stop hook returned {ok:false} and
  // Claude kept working without a new user prompt — indirect detection,
  // source-hook-agnostic)
  store.on('forcedContinuation', (data) => {
    broadcast({
      type: 'forcedContinuation',
      data,
    });
  });

  // Broadcast hook performance events
  store.on('hookPerfEvent', (data) => {
    broadcast({
      type: 'hookPerfEvent',
      data,
    });
  });

  console.log('[ws] WebSocket broadcaster ready');
}

function broadcast(message) {
  if (!wss) return;
  const json = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === 1) { // OPEN
      client.send(json);
    }
  }
}

/**
 * Broadcast an arbitrary typed frame from outside this module.
 * Used by wiring code (e.g. the oversight-events watcher in index.js) that
 * has no store EventEmitter of its own. No-op until startBroadcaster runs.
 */
export function broadcastFrame(type, data) {
  broadcast({ type, data });
}
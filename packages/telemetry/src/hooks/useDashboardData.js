import { useReducer, useEffect, useCallback, useRef, useMemo } from 'react';
import { useWebSocket } from './useWebSocket';

const initialState = {
  currentSession: null,
  stats: null,
  sessions: [],
  toolEvents: [],
  liveSessions: {},
  planInfo: { planType: null, displayMode: 'cost', usage: null },
  statusLineState: {
    class: 'unknown',
    command: '',
    scriptPath: null,
    lastCheckedAt: null,
    lastStatusPostAt: null,
    stalled: false,
    reason: null,
  },
  sessionCostTrack: {}, // { [id]: { cost, lastChangeAt } } — tracks when cost last changed
  sessionActivity: {}, // { [id]: 'processing' | 'idle' } — event-driven idle detection
  failureEvents: [],    // recent failure events from WebSocket
  failurePatterns: null, // cached pattern analysis from /api/failures/patterns
  failureAlerts: [],     // recent failure threshold alerts from WebSocket
  selectedSessionId: null,
  timestamp: null,
  connected: false,
};

function reducer(state, action) {
  switch (action.type) {
    case 'SNAPSHOT':
      return {
        ...state,
        ...action.data,
        // Preserve selectedSessionId if still valid, otherwise pick most recent
        selectedSessionId: action.data.liveSessions?.[state.selectedSessionId]
          ? state.selectedSessionId
          : mostRecentId(action.data.liveSessions) || state.selectedSessionId,
        connected: true,
      };
    case 'UPDATE':
      return {
        ...state,
        ...action.data,
        connected: true,
      };
    case 'LIVE_SESSION': {
      const { id, data } = action.payload;
      const liveSessions = { ...state.liveSessions, [id]: data };
      // Auto-select if nothing selected, or if this is the only session
      const selectedSessionId =
        state.selectedSessionId && liveSessions[state.selectedSessionId]
          ? state.selectedSessionId
          : id;
      // Track cost changes to detect processing vs idle
      const newCost = data.cost?.total_cost_usd ?? 0;
      const prev = state.sessionCostTrack[id];
      const costChanged = !prev || prev.cost !== newCost;
      const sessionCostTrack = {
        ...state.sessionCostTrack,
        [id]: { cost: newCost, lastChangeAt: costChanged ? Date.now() : prev.lastChangeAt },
      };
      // Default to idle on first appearance (event-driven detection will set to processing on tool events)
      const sessionActivity = state.sessionActivity[id]
        ? state.sessionActivity
        : { ...state.sessionActivity, [id]: 'idle' };
      return { ...state, liveSessions, selectedSessionId, sessionCostTrack, sessionActivity };
    }
    case 'PROMPT_UPDATE': {
      const { sessionId, prompt, history } = action.data;
      const sess = state.liveSessions[sessionId];
      if (!sess) return state;
      const now = Date.now();
      return {
        ...state,
        liveSessions: {
          ...state.liveSessions,
          [sessionId]: {
            ...sess,
            _currentPrompt: prompt,
            _promptHistory: history || sess._promptHistory,
            // Stamp lifecycle timestamps client-side so the heartbeat can
            // detect "between turns" without waiting for the next statusLine
            // refresh. Do NOT clear _currentTurnEvents here — the server's
            // updatePrompt clears it server-side, and the next LIVE_SESSION
            // dispatch carries the empty array through. Clearing client-side
            // creates a brief flicker between this dispatch and the next
            // statusLine refresh that's especially visible in auto mode.
            _lastUserPromptAt: now,
            _currentTurnStartTs: now,
          },
        },
        // User submitted a new prompt = session is now processing
        sessionActivity: { ...state.sessionActivity, [sessionId]: 'processing' },
      };
    }
    case 'SELECT_SESSION':
      return { ...state, selectedSessionId: action.id };
    case 'TOOL_EVENT': {
      const sessionId = action.data.session;
      const sessionActivity = sessionId
        ? { ...state.sessionActivity, [sessionId]: 'processing' }
        : state.sessionActivity;
      return {
        ...state,
        toolEvents: [action.data, ...state.toolEvents].slice(0, 200),
        sessionActivity,
      };
    }
    case 'TURN_END': {
      const { sessionId, turn, cost: turnCost, ctxPct, tokensPerTurn, turnsRemaining } = action.data;
      const sess = state.liveSessions[sessionId];
      if (!sess) return state;
      // Update only turn-tracking fields — do NOT spread action.data onto sess,
      // because action.data.cost is a per-turn delta (number) that would overwrite
      // sess.cost (the total cost object { total_cost_usd: X }), resetting the
      // displayed cost to 0.
      return {
        ...state,
        liveSessions: {
          ...state.liveSessions,
          [sessionId]: {
            ...sess,
            _turnCount: turn,
            _lastTurnCostDelta: turnCost,
            _tokensPerTurn: tokensPerTurn,
            _estimatedTurnsRemaining: turnsRemaining,
            // Stamp client-side so the heartbeat can render the user-waiting
            // idle band immediately on Stop, without waiting for the next
            // statusLine refresh.
            _lastStopAt: Date.now(),
          },
        },
        sessionActivity: { ...state.sessionActivity, [sessionId]: 'idle' },
      };
    }
    case 'COMPACT_EVENT': {
      const { sessionId } = action.data;
      const sess = state.liveSessions[sessionId];
      if (!sess) return state;
      return {
        ...state,
        liveSessions: {
          ...state.liveSessions,
          [sessionId]: {
            ...sess,
            _lastCompactAt: action.data.ts || Date.now(),
            _compactEvents: [...(sess._compactEvents || []), action.data],
          },
        },
      };
    }
    case 'SUBAGENT_UPDATE': {
      const { sessionId, activeSubagents, subagentHistory } = action.data;
      const sess = state.liveSessions[sessionId];
      if (!sess) return state;
      return {
        ...state,
        liveSessions: {
          ...state.liveSessions,
          [sessionId]: {
            ...sess,
            _activeSubagents: activeSubagents || sess._activeSubagents,
            _subagentHistory: subagentHistory || sess._subagentHistory,
          },
        },
      };
    }
    case 'CONFIG_CHANGE': {
      const { sessionId, event } = action.data;
      const sess = state.liveSessions[sessionId];
      if (!sess) return state;
      const existing = sess._configChanges || [];
      return {
        ...state,
        liveSessions: {
          ...state.liveSessions,
          [sessionId]: {
            ...sess,
            _configChanges: [...existing, event].slice(-20),
          },
        },
      };
    }
    case 'TASK_COMPLETED': {
      const { sessionId, task } = action.data;
      const sess = state.liveSessions[sessionId];
      if (!sess) return state;
      const existing = sess._completedTasks || [];
      return {
        ...state,
        liveSessions: {
          ...state.liveSessions,
          [sessionId]: {
            ...sess,
            _completedTasks: [...existing, task].slice(-50),
          },
        },
      };
    }
    case 'FORCED_CONTINUATION': {
      const { sessionId, entry, consecutive, total } = action.data;
      const sess = state.liveSessions[sessionId];
      if (!sess) return state;
      const existing = sess._forcedContinuations || [];
      return {
        ...state,
        liveSessions: {
          ...state.liveSessions,
          [sessionId]: {
            ...sess,
            _forcedContinuations: [...existing, entry].slice(-50),
            _consecutiveForcedContinuations: consecutive,
            _forcedContinuationCount: total,
          },
        },
      };
    }
    case 'FAILURE_EVENT':
      return {
        ...state,
        failureEvents: [action.data, ...state.failureEvents].slice(0, 100),
      };
    case 'FAILURE_ALERT':
      return {
        ...state,
        failureAlerts: [action.data, ...state.failureAlerts].slice(0, 20),
      };
    case 'FAILURE_PATTERNS':
      return { ...state, failurePatterns: action.data };
    case 'PLAN_INFO':
      return { ...state, planInfo: action.data };
    case 'STATUS_LINE_STATE':
      return { ...state, statusLineState: action.data };
    case 'SET_CONNECTED':
      return { ...state, connected: action.connected };
    default:
      return state;
  }
}

function mostRecentId(sessions) {
  if (!sessions) return null;
  const entries = Object.entries(sessions);
  if (entries.length === 0) return null;
  entries.sort((a, b) => (b[1]._lastSeen || 0) - (a[1]._lastSeen || 0));
  return entries[0][0];
}

export function useDashboardData() {
  const [state, dispatch] = useReducer(reducer, initialState);

  // Derive WebSocket URL from current page location (works in dev via Vite proxy and in prod)
  const wsUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;

  // Dispatch WebSocket messages directly via callback — avoids React state batching drops
  const handleMessage = useCallback((msg) => {
    switch (msg.type) {
      case 'snapshot':
        dispatch({ type: 'SNAPSHOT', data: msg.data });
        break;
      case 'update':
        dispatch({ type: 'UPDATE', data: msg.data });
        break;
      case 'liveSession':
        dispatch({ type: 'LIVE_SESSION', payload: msg.data });
        break;
      case 'toolEvent':
        dispatch({ type: 'TOOL_EVENT', data: msg.data });
        break;
      case 'turnEnd':
        dispatch({ type: 'TURN_END', data: msg.data });
        break;
      case 'compactEvent':
        dispatch({ type: 'COMPACT_EVENT', data: msg.data });
        break;
      case 'subagentUpdate':
        dispatch({ type: 'SUBAGENT_UPDATE', data: msg.data });
        break;
      case 'promptUpdate':
        dispatch({ type: 'PROMPT_UPDATE', data: msg.data });
        break;
      case 'failureEvent':
        dispatch({ type: 'FAILURE_EVENT', data: msg.data });
        break;
      case 'failureAlert':
        dispatch({ type: 'FAILURE_ALERT', data: msg.data });
        break;
      case 'planInfo':
        dispatch({ type: 'PLAN_INFO', data: msg.data });
        break;
      case 'statusLineState':
        dispatch({ type: 'STATUS_LINE_STATE', data: msg.data });
        break;
      case 'configChange':
        dispatch({ type: 'CONFIG_CHANGE', data: msg.data });
        break;
      case 'taskCompleted':
        dispatch({ type: 'TASK_COMPLETED', data: msg.data });
        break;
      case 'forcedContinuation':
        dispatch({ type: 'FORCED_CONTINUATION', data: msg.data });
        break;
    }
  }, []);

  const { connected } = useWebSocket(wsUrl, handleMessage);

  useEffect(() => {
    dispatch({ type: 'SET_CONNECTED', connected });
    if (connected) {
      // Fetch failure patterns on connect/reconnect
      fetch('/api/failures/patterns')
        .then(r => r.json())
        .then(data => dispatch({ type: 'FAILURE_PATTERNS', data }))
        .catch(() => {});
    }
  }, [connected]);

  const selectSession = useCallback((id) => {
    dispatch({ type: 'SELECT_SESSION', id });
  }, []);

  // Stabilize sessionIds reference — only produce a new array when the actual
  // IDs change.  Object.keys() creates a new array every render, which causes
  // every useEffect in App.jsx that depends on sessionIds to re-fire on every
  // single WebSocket message.  This ref-based comparison prevents that cascade
  // and stops the dashboard from "resetting" (effects re-running → tab switches,
  // fileSessions rebuilds, etc.).
  const prevIdsRef = useRef([]);
  const sessionIds = useMemo(() => {
    const next = Object.keys(state.liveSessions);
    const prev = prevIdsRef.current;
    if (next.length === prev.length && next.every((id, i) => id === prev[i])) {
      return prev;
    }
    prevIdsRef.current = next;
    return next;
  }, [state.liveSessions]);

  const activeLiveSession = state.selectedSessionId
    ? state.liveSessions[state.selectedSessionId] || null
    : null;

  return {
    ...state,
    activeLiveSession,
    sessionIds,
    selectSession,
  };
}
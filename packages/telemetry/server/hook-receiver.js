import { Router } from 'express';
import { store } from './store.js';
import { getHookHealth } from './hook-health.js';

const router = Router();

// Receive hook events from Claude Code
// Claude Code hooks send POST with JSON body containing tool info
router.post('/hooks', (req, res) => {
  try {
    const event = req.body;
    if (event && (event.tool_name || event.tool)) {
      store.addToolEvent(event);
      console.log(`[hooks] Tool event: ${event.tool_name || event.tool}`);

      // Persist failures to JSONL store
      if (event.success === false || event.event_type === 'post_tool_use_failure') {
        // D3 — attach the current prompt context so the Failures tab can link
        // "this failure happened while Claude was working on this prompt"
        const promptCtx = store._promptContextFor(event.session_id || '');
        store.failureStore.append({
          sessionId: event.session_id || '',
          toolName: event.tool_name || event.tool || 'unknown',
          eventType: event.event_type || 'post_tool_use_failure',
          error: event.error || 'Unknown error',
          toolInput: event.tool_input || null,
          cwd: event.cwd || '',
          durationMs: event.duration_ms || null,
          promptId: promptCtx.promptId,
          promptSnippet: promptCtx.promptSnippet,
          // D4 — caller may attach an estimatedCost for cost-weighted ranking
          estimatedCost: typeof event.estimated_cost === 'number' ? event.estimated_cost : null,
        });
      }
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[hooks] Error processing event:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// Receive statusLine data for live in-session telemetry
router.post('/status', (req, res) => {
  try {
    const data = req.body;
    if (data) {
      store.updateLiveSession(data);
      // Only real statusLine-sourced posts should reset stall detection.
      // toolPiggyback posts (fired from PostToolUse via hook-forwarder.js tool
      // mode) would otherwise mask a broken statusLine because every tool
      // event also carries a status payload.
      const source = data._source || '';
      if (source === 'statusLine' || source === 'statusLineWrapped') {
        store.recordStatusLinePost();
      }
      console.log(`[status] ${data.session_id?.slice(0, 8) || '?'}: ${data.model?.display_name || 'unknown'} — $${data.cost?.total_cost_usd?.toFixed(4) ?? '?'} [ctx: ${data.context_window?.used_percentage || '?'}%]${source ? ` (${source})` : ''}`);
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[status] Error processing statusLine data:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// SessionEnd hook: mark ended (NOT pruned — lingers until stale prune)
router.post('/session-end', (req, res) => {
  try {
    const sessionId = req.body?.session_id || '';
    if (sessionId) {
      store.markSessionEnded(sessionId);
      console.log(`[session-end] ${sessionId.slice(0, 8)}: session ended (kept until stale prune)`);
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[session-end] Error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// PermissionRequest hook: session is blocked on a user permission decision
router.post('/permission-request', (req, res) => {
  try {
    const sessionId = req.body?.session_id || '';
    if (sessionId) {
      store.markAwaitingPermission(sessionId, req.body?.tool_name || null);
      console.log(`[permission] ${sessionId.slice(0, 8)}: awaiting decision on ${req.body?.tool_name || '?'}`);
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[permission] Error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// Receive turn-end events from Stop hook
router.post('/turn-end', (req, res) => {
  try {
    const data = req.body;
    const sessionId = data?.session_id || '';
    if (sessionId) {
      store.recordTurnEnd(sessionId, data);
      console.log(`[turn-end] ${sessionId.slice(0, 8)}: turn ended`);
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[turn-end] Error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// Receive compact events from PreCompact hook
router.post('/compact', (req, res) => {
  try {
    const data = req.body;
    const sessionId = data?.session_id || '';
    if (sessionId) {
      store.recordCompact(sessionId, data);
      console.log(`[compact] ${sessionId.slice(0, 8)}: compact event (${data.trigger || 'auto'})`);
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[compact] Error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// Receive subagent events from SubagentStart/SubagentStop hooks
router.post('/subagent', (req, res) => {
  try {
    const data = req.body;
    const sessionId = data?.session_id || '';
    const action = data?.action || '';
    if (sessionId && action === 'start') {
      store.addSubagent(sessionId, data);
      console.log(`[subagent] ${sessionId.slice(0, 8)}: started ${data.agent_type || 'unknown'}${data.description ? ` — ${data.description.slice(0, 60)}` : ''}`);
    } else if (sessionId && action === 'stop') {
      store.removeSubagent(sessionId, data);
      const metrics = data._transcriptMetrics;
      const metricsSummary = metrics?.model?.display_name
        ? ` (${metrics.model.display_name}, ${metrics.tokens?.total || 0} tokens, $${metrics.cost?.total_cost_usd?.toFixed(4) || '0'})`
        : '';
      console.log(`[subagent] ${sessionId.slice(0, 8)}: stopped ${data.agent_id || '?'}${metricsSummary}`);
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[subagent] Error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// Receive user prompt from UserPromptSubmit hook
router.post('/prompt', (req, res) => {
  try {
    const data = req.body;
    const sessionId = data?.session_id || '';
    const prompt = data?.prompt || '';
    if (sessionId && prompt) {
      store.updatePrompt(sessionId, prompt);
      console.log(`[prompt] ${sessionId.slice(0, 8)}: ${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}`);
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[prompt] Error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// Receive config change events from ConfigChange hook
router.post('/config-change', (req, res) => {
  try {
    const data = req.body;
    const sessionId = data?.session_id || '';
    if (sessionId) {
      store.recordConfigChange(sessionId, data);
      console.log(`[config-change] ${sessionId.slice(0, 8)}: config modified${data.config_path ? ` (${data.config_path})` : ''}`);
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[config-change] Error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// Receive task completed events from TaskCompleted hook
router.post('/task-completed', (req, res) => {
  try {
    const data = req.body;
    const sessionId = data?.session_id || '';
    if (sessionId) {
      store.recordTaskCompleted(sessionId, data);
      console.log(`[task-completed] ${sessionId.slice(0, 8)}: ${data.task_description?.slice(0, 60) || data.task_id || '?'}`);
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[task-completed] Error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// ── Failure Query Endpoints ──────────────────────────────────────────────────

// Query failure history with optional filters
router.get('/failures', (req, res) => {
  try {
    const { session, tool, since, limit } = req.query;
    const results = store.failureStore.query({
      sessionId: session || undefined,
      toolName: tool || undefined,
      since: since ? parseInt(since) : undefined,
      limit: limit ? parseInt(limit) : undefined,
    });
    res.json(results);
  } catch (err) {
    console.error('[failures] Query error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Failure frequency analysis (by tool, by error, by session)
router.get('/failures/patterns', (_req, res) => {
  try {
    res.json(store.failureStore.getPatterns());
  } catch (err) {
    console.error('[failures/patterns] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Failure digest for a time period (default: last 24h)
router.get('/failures/digest', (req, res) => {
  try {
    const since = req.query.since ? parseInt(req.query.since) : Date.now() - 24 * 60 * 60 * 1000;
    res.json(store.failureStore.getDigest(since));
  } catch (err) {
    console.error('[failures/digest] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Failure alert threshold configuration
router.get('/failures/alert-threshold', (_req, res) => {
  try {
    res.json(store.failureAlerter.getConfig());
  } catch (err) {
    console.error('[failures/alert-threshold] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// D5 — hook-forwarder self-health. Reads the tail of hook-debug.log and
// returns error-line count + transcript-parse P95 latency so the dashboard
// can show "hooks ok" / "hooks failing" at a glance.
router.get('/hook-health', (_req, res) => {
  try {
    res.json(getHookHealth());
  } catch (err) {
    console.error('[hook-health] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Top failures by estimated cost (D4)
router.get('/failures/top-cost', (req, res) => {
  try {
    const n = Math.min(parseInt(req.query.n || '3', 10), 25);
    const sinceMs = req.query.since ? parseInt(req.query.since, 10) : Date.now() - 24 * 60 * 60 * 1000;
    res.json(store.failureStore.getTopCostFailures(n, sinceMs));
  } catch (err) {
    console.error('[failures/top-cost] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Hook Performance Endpoints ──────────────────────────────────────────────

// Receive hook latency records from oversight hooks
router.post('/hook-perf', (req, res) => {
  try {
    const record = req.body;
    if (record && record.hook) {
      store.hookPerfStore.append(record);
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[hook-perf] Error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// Per-hook latency stats (default: last 24h)
router.get('/hook-perf', (req, res) => {
  try {
    const since = req.query.since ? parseInt(req.query.since, 10) : Date.now() - 24 * 60 * 60 * 1000;
    res.json(store.hookPerfStore.getStats(since));
  } catch (err) {
    console.error('[hook-perf] Stats error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Top N slowest hook invocations
router.get('/hook-perf/slowest', (req, res) => {
  try {
    const n = Math.min(parseInt(req.query.n || '10', 10), 50);
    const since = req.query.since ? parseInt(req.query.since, 10) : Date.now() - 24 * 60 * 60 * 1000;
    res.json(store.hookPerfStore.getSlowest(n, since));
  } catch (err) {
    console.error('[hook-perf/slowest] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Regression detection (current 24h p95 vs 7-day baseline p95)
router.get('/hook-perf/regressions', (req, res) => {
  try {
    const baselineSince = req.query.baseline ? parseInt(req.query.baseline, 10) : undefined;
    const currentSince = req.query.current ? parseInt(req.query.current, 10) : undefined;
    res.json(store.hookPerfStore.detectRegressions(baselineSince, currentSince));
  } catch (err) {
    console.error('[hook-perf/regressions] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Debug: log raw incoming hook payloads (temporary)
router.post('/debug-hooks', (req, res) => {
  console.log('[debug-hooks] Raw body:', JSON.stringify(req.body, null, 2).slice(0, 2000));
  res.status(200).json({ ok: true });
});

export default router;
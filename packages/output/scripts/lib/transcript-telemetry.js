/**
 * transcript-telemetry.js — pure aggregation of Claude Code transcript JSONL
 * into the ctx_* telemetry shapes (Phase 3.5, PLAN-2026-06-13-context-db).
 *
 * No DB, no I/O — just parse + fold, so it's exhaustively unit-testable. The
 * writers (context-db.js) and the ingest wiring (rh-transcript-ingest.js) call
 * these. Cost is estimated from token counts via the CJS cost-rates mirror
 * because the transcript JSONL does NOT carry a per-line cost (verified 2026-06-14:
 * message.usage has tokens, no costUSD).
 *
 * Real assistant-line shape (verified):
 *   { type:'assistant', timestamp, message:{ model,
 *       usage:{ input_tokens, output_tokens, cache_read_input_tokens,
 *               cache_creation_input_tokens }, content:[ {type:'tool_use'|...} ] } }
 */

const { estimateCost } = require('./cost-rates');

// Parse one JSONL line → a per-turn telemetry record, or null if the line is
// not an assistant message carrying a usage/model signal.
function parseTelemetryLine(line) {
  let j;
  try { j = JSON.parse(line); } catch { return null; }
  if (j.type !== 'assistant' || !j.message) return null;
  const u = j.message.usage || {};
  const input = u.input_tokens || 0;
  const output = u.output_tokens || 0;
  const cacheRead = u.cache_read_input_tokens || 0;
  const cacheWrite = u.cache_creation_input_tokens || 0;
  const model = j.message.model || null;
  if (!input && !output && !cacheRead && !cacheWrite && !model) return null;
  let toolCalls = 0;
  if (Array.isArray(j.message.content)) {
    toolCalls = j.message.content.filter(b => b && b.type === 'tool_use').length;
  }
  return {
    ts: j.timestamp || null,
    model,
    input_tokens: input,
    output_tokens: output,
    cache_read: cacheRead,
    cache_write: cacheWrite,
    tool_calls: toolCalls,
    // cost is estimated (transcript carries no cost); null when model unknown.
    cost_usd: model ? estimateCost(model, { input, output, cacheRead, cacheWrite }) : null,
  };
}

// Parse a whole transcript's text into per-turn telemetry records (skips
// non-assistant / no-usage lines). `text` is the raw JSONL file content.
function parseTranscriptTelemetry(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const r = parseTelemetryLine(line);
    if (r) out.push(r);
  }
  return out;
}

// Fold per-turn records → { modelUsage:[...], snapshot:{...} }. Pure.
function aggregateSession(records) {
  const byModel = new Map();
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0, toolCalls = 0, msgCount = 0;
  let firstTs = null, lastTs = null, costMeasured = false;
  for (const r of records || []) {
    if (!r) continue;
    msgCount++;
    input += r.input_tokens; output += r.output_tokens;
    cacheRead += r.cache_read; cacheWrite += r.cache_write;
    toolCalls += r.tool_calls;
    if (r.cost_usd != null) { cost += r.cost_usd; costMeasured = true; }
    if (r.ts) { if (!firstTs) firstTs = r.ts; lastTs = r.ts; }
    const m = r.model || 'unknown';
    if (!byModel.has(m)) byModel.set(m, { model_id: m, input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0, cost_usd: 0, message_count: 0 });
    const g = byModel.get(m);
    g.input_tokens += r.input_tokens; g.output_tokens += r.output_tokens;
    g.cache_read += r.cache_read; g.cache_write += r.cache_write;
    g.cost_usd += (r.cost_usd || 0); g.message_count++;
  }
  let primary = null, max = -1;
  for (const g of byModel.values()) {
    const t = g.input_tokens + g.output_tokens + g.cache_read + g.cache_write;
    if (t > max) { max = t; primary = g.model_id; }
  }
  const span = (firstTs && lastTs) ? (Date.parse(lastTs) - Date.parse(firstTs)) : NaN;
  const wall_ms = Number.isFinite(span) && span > 0 ? span : null;
  const model_mix = {};
  for (const g of byModel.values()) model_mix[g.model_id] = g.message_count;
  return {
    modelUsage: [...byModel.values()],
    snapshot: {
      primary_model: primary,
      wall_ms,
      total_cost: costMeasured ? cost : 0,
      input_tokens: input, output_tokens: output, cache_read: cacheRead, cache_write: cacheWrite,
      message_count: msgCount, tool_call_count: toolCalls,
      model_mix,
      first_ts: firstTs, last_ts: lastTs,
    },
  };
}

// Aggregate a subagent transcript into a ctx_subagent_run shape. Status:
// 'ok' if it produced any assistant turn, else 'orphaned' (no output captured).
function aggregateSubagentRun(records, { agent_id, parent_session_id, agent_type } = {}) {
  const { modelUsage, snapshot } = aggregateSession(records);
  const total_tokens = snapshot.input_tokens + snapshot.output_tokens + snapshot.cache_read + snapshot.cache_write;
  return {
    agent_id,
    parent_session_id: parent_session_id || undefined,
    agent_type: agent_type || undefined,
    status: snapshot.message_count > 0 ? 'ok' : 'orphaned',
    first_ts: snapshot.first_ts,
    last_ts: snapshot.last_ts,
    duration_ms: snapshot.wall_ms,
    tool_call_count: snapshot.tool_call_count,
    total_cost: snapshot.total_cost,
    total_tokens,
    primary_model: snapshot.primary_model,
    _modelUsage: modelUsage,
  };
}

module.exports = { parseTelemetryLine, parseTranscriptTelemetry, aggregateSession, aggregateSubagentRun };

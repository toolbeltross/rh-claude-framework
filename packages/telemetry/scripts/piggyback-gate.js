// piggyback-gate.js — decide whether a PostToolUse event should ALSO emit a
// synthetic /api/status "toolPiggyback" post.
//
// The piggyback exists so the desktop app (which has no statusLine hook) still
// shows live data for the INTERACTIVE session the user is driving: every tool
// event carries enough transcript info to refresh that session's live tab.
//
// It must NOT fire for tool events that belong to an AGENT, because an agent
// runs under its own session_id, so an un-gated piggyback mints a phantom
// top-level session tab per agent. Two agent shapes must both be excluded:
//   - Task-tool subagent  → payload carries `agent_id`
//   - `claude -p --agent <name>` headless run → payload carries `agent_type`,
//     frequently with NO `agent_id` (verified 2026-06-19: 126 of 153 agent
//     tool events had agent_type set but agent_id null). Hence we must check
//     BOTH fields — gating on agent_id alone misses every `--agent` run.
//
// Incident that motivated this (2026-06-19): a midnight burst of concurrent
// rh-daily-regen pipeline runs (no mutual-exclusion lock) each dispatched the
// rh-daily-guidance `--agent` worker before the per-day digest existed,
// spawning ~30 headless agents. Each surfaced as its own top-level live-session
// tab in the dashboard. This gate keeps them out of the session tab bar.
//
// Subagent/agent telemetry is unaffected: the tool event itself still forwards
// with agent_id/agent_type (server-side _activeSubagents nesting + live-agent
// metrics), so agents still appear nested under their parent's Agents tab where
// they belong — just not as standalone top-level sessions.

/**
 * @param {object} ev
 * @param {string} [ev.transcriptPath] transcript_path from the hook payload
 * @param {string} [ev.sessionId]      session_id from the hook payload
 * @param {string} [ev.agentId]        agent_id (set for Task-tool subagents)
 * @param {string} [ev.agentType]      agent_type (set for `--agent` runs / subagents)
 * @returns {boolean} true → emit the toolPiggyback status post
 */
export function shouldPiggybackStatus({ transcriptPath, sessionId, agentId, agentType } = {}) {
  // Nothing to parse from / nothing to key the session on.
  if (!transcriptPath || !sessionId) return false;
  // Belongs to an agent (subagent or headless --agent) — don't mint a
  // standalone top-level session for it.
  if (agentId || agentType) return false;
  return true;
}

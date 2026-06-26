/**
 * Mock fixture data for visual parity testing.
 * Returns ordered API calls that seed both dev and prod servers identically.
 */

const SESSION_ID = 'vptest-session-00000001';
const AGENT_ID_ACTIVE = 'agent-vp-active-001';
const AGENT_ID_DONE = 'agent-vp-done-001';

const now = Date.now();

export function getFixtures() {
  return [
    // 1. Status payload — creates the live session with full context window
    {
      endpoint: '/api/status',
      body: {
        session_id: SESSION_ID,
        model: {
          id: 'claude-opus-4-6',
          display_name: 'Opus',
        },
        cost: {
          total_cost_usd: 3.4712,
        },
        context_window: {
          used_percentage: 45,
          total_input_tokens: 90000,
          context_window_size: 200000,
          input_tokens: 52000,
          output_tokens: 18000,
          cache_read_tokens: 15000,
          cache_write_tokens: 5000,
        },
        workspace: {
          current_dir: '/home/user/projects/rh-telemetry',
        },
      },
    },

    // 2. Tool events — mix of tools with timestamps spread across time
    ...generateToolEvents(),

    // 3. Subagent start (completed one — will be stopped below)
    {
      endpoint: '/api/subagent',
      body: {
        session_id: SESSION_ID,
        action: 'start',
        agent_id: AGENT_ID_DONE,
        agent_type: 'Explore',
        description: 'Search codebase for visual test patterns',
        model: 'claude-sonnet-4-6',
      },
    },

    // 4. Subagent stop (completed)
    {
      endpoint: '/api/subagent',
      body: {
        session_id: SESSION_ID,
        action: 'stop',
        agent_id: AGENT_ID_DONE,
        last_assistant_message: 'Found 3 matching patterns in src/components/',
      },
    },

    // 5. Subagent start (still active)
    {
      endpoint: '/api/subagent',
      body: {
        session_id: SESSION_ID,
        action: 'start',
        agent_id: AGENT_ID_ACTIVE,
        agent_type: 'Plan',
        description: 'Design implementation strategy for visual parity agent',
        model: 'claude-opus-4-6',
      },
    },

    // 6. Turn ends — creates turn history for TurnTracker/TurnCostChart
    {
      endpoint: '/api/turn-end',
      body: { session_id: SESSION_ID },
    },

    // 7. Second status update (simulates cost increase after turn)
    {
      endpoint: '/api/status',
      body: {
        session_id: SESSION_ID,
        model: {
          id: 'claude-opus-4-6',
          display_name: 'Opus',
        },
        cost: {
          total_cost_usd: 4.1205,
        },
        context_window: {
          used_percentage: 52,
          total_input_tokens: 104000,
          context_window_size: 200000,
          input_tokens: 62000,
          output_tokens: 22000,
          cache_read_tokens: 14000,
          cache_write_tokens: 6000,
        },
        workspace: {
          current_dir: '/home/user/projects/rh-telemetry',
        },
      },
    },

    // 8. Second turn end
    {
      endpoint: '/api/turn-end',
      body: { session_id: SESSION_ID },
    },

    // 9. Third status update
    {
      endpoint: '/api/status',
      body: {
        session_id: SESSION_ID,
        model: {
          id: 'claude-opus-4-6',
          display_name: 'Opus',
        },
        cost: {
          total_cost_usd: 4.8933,
        },
        context_window: {
          used_percentage: 58,
          total_input_tokens: 116000,
          context_window_size: 200000,
          input_tokens: 70000,
          output_tokens: 26000,
          cache_read_tokens: 14000,
          cache_write_tokens: 6000,
        },
        workspace: {
          current_dir: '/home/user/projects/rh-telemetry',
        },
      },
    },

    // 10. Compact event
    {
      endpoint: '/api/compact',
      body: {
        session_id: SESSION_ID,
        trigger: 'auto',
      },
    },

    // 11. Prompt — current prompt text
    {
      endpoint: '/api/prompt',
      body: {
        session_id: SESSION_ID,
        prompt: 'Build a visual parity agent that compares Vite dev and production builds to ensure they visually match',
      },
    },

    // 12. Third turn end
    {
      endpoint: '/api/turn-end',
      body: { session_id: SESSION_ID },
    },
  ];
}

function generateToolEvents() {
  const tools = [
    { tool: 'Read', success: true },
    { tool: 'Read', success: true },
    { tool: 'Glob', success: true },
    { tool: 'Bash', success: true },
    { tool: 'Grep', success: true },
    { tool: 'Read', success: true },
    { tool: 'Write', success: true },
    { tool: 'Edit', success: true },
    { tool: 'Bash', success: true },
    { tool: 'Read', success: true },
    { tool: 'Bash', success: false, error: 'Command failed with exit code 1' },
    { tool: 'Grep', success: true },
    { tool: 'Edit', success: true },
    { tool: 'Bash', success: true },
    { tool: 'Read', success: true },
  ];

  return tools.map((t, i) => ({
    endpoint: '/api/hooks',
    body: {
      session_id: SESSION_ID,
      tool_name: t.tool,
      tool_input: {},
      event_type: 'tool_call',
      success: t.success,
      error: t.error || null,
    },
  }));
}

export { SESSION_ID };
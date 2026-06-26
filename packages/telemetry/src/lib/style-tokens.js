/**
 * Single source of truth for color and typography tokens used across components.
 *
 * Do not scatter inline color choices in components — import from here so
 * future changes propagate.
 *
 * =============================================================================
 * COLOR SYSTEM — FIVE PALETTES
 * =============================================================================
 * Five distinct palettes coexist. Each governs a different semantic domain.
 * The rule for keeping them separate is non-negotiable: if a viewer can't
 * tell whether a color means "this model" or "this tool" or "this state,"
 * the color choice is wrong.
 *
 * 1. STATUS — communicates STATE (good/bad/caution/idle).
 *    green  #34d399  success, processing, live, low-utilization
 *    red    #f87171  failure, blocked, high-utilization, critical
 *    amber  #fbbf24  warning, medium-utilization, stalled, validation block
 *    blue   #60a5fa  idle (session activity dot = "turn ended, waiting")
 *
 *    Status colors must NEVER be applied as category identity for tools,
 *    agents, models, or metrics. A red Bash tool reads as "Bash failed."
 *
 * 2. MODEL — communicates which model is running. Defined in `model-colors.js`.
 *    accent #8b5cf6  Opus
 *    blue   #60a5fa  Sonnet
 *    cyan   #22d3ee  Haiku
 *
 *    Model colors ONLY appear where the intent is "this is Opus / Sonnet /
 *    Haiku." Contexts: model name labels, model dots next to agent names,
 *    model breakdown pie/bar charts, cost-per-model tables.
 *
 *    Do NOT use model colors for unrelated metrics. Cyan text that says
 *    "Cache Read 1.0M" looks like "Haiku" at a glance — that's a collision.
 *
 * 3. IDENTITY — distinguishes TOOL/AGENT CATEGORIES.
 *    blue     #60a5fa  File I/O (Read, Write, Edit)
 *    cyan     #22d3ee  Runtime / shell / network (Bash, WebFetch)
 *    accent   #8b5cf6  Orchestration (Grep, Glob, Agent, Task)
 *    gray-300 #aaaabb  Meta / utility (ToolSearch, AskUserQuestion)
 *
 *    KNOWN COLLISION: identity and model palettes share hex values. This is
 *    intentional — the same blue that means "Sonnet" also means "File I/O."
 *    Context disambiguates: a blue dot next to a model name = Sonnet; a blue
 *    dot next to a tool name = File I/O category. If context can't disambiguate,
 *    model wins — add a category label instead of relying on color alone.
 *
 * 4. METRICS — data visualization for token counts and resource quantities.
 *    blue   #60a5fa  Uncached input tokens (fresh, not from cache)
 *    green  #34d399  Output tokens (model-generated)
 *    cyan   #22d3ee  Cache read tokens (reused from cache)
 *    amber  #fbbf24  Cache write tokens (saved for future reuse)
 *
 *    These overlap with status and model colors. The collision is documented,
 *    not ideal, and tolerated because the token-type colors are well-established
 *    and always appear with their labels ("Cache Read", "Output", etc.).
 *    Future work: consider shifting to unique tints for metrics.
 *
 * 5. VIZ — activity visualizations (heatmaps, playheads, timelines).
 *    green  #34d399  Active processing / tool activity density
 *    blue   #60a5fa  User-waiting idle (between Stop and next UserPromptSubmit)
 *    accent #8b5cf6  Subagent activity overlay (top stripe on events with agentId)
 *    amber  #fbbf24  Compaction event marker (vertical line on the heartbeat)
 *    red    #f87171  Forced-continuation marker (Layer 3a Stop rejection forced retry)
 *
 *    The TurnHeartbeat heatmap and playhead use green because the strip
 *    represents "processing is happening" — the same semantic as the green
 *    pulsing session dot. Using cyan here would read as "Haiku model."
 *
 *    VIZ.idle is the same hex as STATUS.idle (the blue session dot) so
 *    "blue dot mode" reads consistently across the dashboard: the dot, the
 *    heartbeat fill, and any future timeline overlays all use the same color.
 *
 *    VIZ.subagent overlays a thin stripe on top of a tool block whose event
 *    carries an agentId — distinguishing parent-thread tool calls from
 *    subagent-thread tool calls without changing the underlying tool-category
 *    color encoding.
 *
 *    VIZ.compaction and VIZ.forcedContinuation are vertical event markers
 *    (instantaneous events, not durations). Their hex values match the
 *    existing SubagentTimeline overlays and STATUS palette respectively, so
 *    the visual language is consistent across surfaces. Model-switch markers
 *    on the heartbeat use the destination model's color from `model-colors.js`
 *    (Opus = accent, Sonnet = blue, Haiku = cyan) — there's no VIZ token for
 *    model switches because the color comes from the model palette directly.
 *
 * PRIORITY WHEN COLORS COLLIDE:
 *   Model context → model palette wins
 *   Tool/agent list → identity palette wins
 *   Labeled metrics → metrics palette (tolerated, always has text label)
 *   Activity viz → VIZ palette (green for processing)
 *   State indicators → status palette wins
 *
 * Underlying hex values are defined in `src/index.css` as Tailwind theme
 * tokens (`--color-blue`, `--color-cyan`, `--color-accent`, etc.).
 */

// ─── Status palette ─────────────────────────────────────────────────────────
// RESERVED for state. Do not use these for identity.
export const STATUS = {
  success: { text: 'text-green', bg: 'bg-green', border: 'border-green', hex: '#34d399' },
  failure: { text: 'text-red',   bg: 'bg-red',   border: 'border-red',   hex: '#f87171' },
  warning: { text: 'text-amber', bg: 'bg-amber', border: 'border-amber', hex: '#fbbf24' },
  idle:    { text: 'text-blue',  bg: 'bg-blue',  border: 'border-blue',  hex: '#60a5fa' },
  neutral: { text: 'text-gray-400', bg: 'bg-gray-700', border: 'border-gray-700', hex: '#8888a0' },
};

// ─── Identity palette ───────────────────────────────────────────────────────
// Used to distinguish CATEGORIES (tools, agents, etc.). Each entry includes
// a human-readable label for use in legends.
export const IDENTITY = {
  fileio:        { text: 'text-blue',     bg: 'bg-blue',     hex: '#60a5fa', label: 'File I/O' },
  runtime:       { text: 'text-cyan',     bg: 'bg-cyan',     hex: '#22d3ee', label: 'Shell/Network' },
  orchestration: { text: 'text-accent',   bg: 'bg-accent',   hex: '#8b5cf6', label: 'Orchestration' },
  meta:          { text: 'text-gray-300', bg: 'bg-gray-300', hex: '#aaaabb', label: 'Meta' },
};

// ─── Visualization palette ──────────────────────────────────────────────────
// Dedicated colors for activity visualizations (heatmaps, playheads,
// timelines). Uses green = "processing/active" to stay congruent with the
// session processing dot and avoid collision with model identity colors.
export const VIZ = {
  activity: {
    hex: '#34d399',
    rgba: (a) => `rgba(52, 211, 153, ${a})`,
    text: 'text-green',
    bg: 'bg-green',
    label: 'tool activity',
  },
  idle: {
    hex: '#60a5fa',
    rgba: (a) => `rgba(96, 165, 250, ${a})`,
    text: 'text-blue',
    bg: 'bg-blue',
    label: 'user-waiting idle',
  },
  subagent: {
    hex: '#8b5cf6',
    rgba: (a) => `rgba(139, 92, 246, ${a})`,
    text: 'text-accent',
    bg: 'bg-accent',
    label: 'subagent thread',
  },
  compaction: {
    hex: '#fbbf24',
    rgba: (a) => `rgba(251, 191, 36, ${a})`,
    text: 'text-amber',
    bg: 'bg-amber',
    label: 'compaction event',
  },
  forcedContinuation: {
    hex: '#f87171',
    rgba: (a) => `rgba(248, 113, 113, ${a})`,
    text: 'text-red',
    bg: 'bg-red',
    label: 'forced continuation',
  },
};

// ─── Tool → category map ────────────────────────────────────────────────────
// Source: recovered from canonical's pre-merge working tree as a STARTING
// POINT. Categorization is open to revision; the rule (no status colors) is
// not. MCP-server-prefixed tools (mcp__server__name) resolve via prefix-strip.
const TOOL_CATEGORY = {
  // File I/O
  Read:            'fileio',
  Write:           'fileio',
  Edit:            'fileio',
  NotebookEdit:    'fileio',
  // Shell / network
  Bash:            'runtime',
  WebFetch:        'runtime',
  WebSearch:       'runtime',
  // Search & orchestration
  Glob:            'orchestration',
  Grep:            'orchestration',
  Task:            'orchestration',
  Agent:           'orchestration',
  TodoWrite:       'orchestration',
  TaskCreate:      'orchestration',
  TaskUpdate:      'orchestration',
  TaskList:        'orchestration',
  EnterPlanMode:   'orchestration',
  ExitPlanMode:    'orchestration',
  Skill:           'orchestration',
  // Meta
  ToolSearch:      'meta',
  AskUserQuestion: 'meta',
};

// Strip `mcp__<server>__` prefix to the bare action name so MCP-prefixed
// tool names resolve through the same category map.
export function stripMcpPrefix(raw) {
  if (!raw) return raw;
  const m = String(raw).match(/^mcp__[^_]+__(.+)$/);
  return m ? m[1] : raw;
}

/**
 * Resolve a tool name (raw, possibly MCP-prefixed) to an IDENTITY palette
 * entry. Unknown tools resolve to IDENTITY.meta.
 */
export function getToolColor(toolName) {
  if (!toolName) return IDENTITY.meta;
  const name = stripMcpPrefix(toolName);
  return IDENTITY[TOOL_CATEGORY[name]] || IDENTITY.meta;
}

/** Resolve a tool name to its category key string ('fileio'|'runtime'|...). */
export function getToolCategory(toolName) {
  if (!toolName) return 'meta';
  return TOOL_CATEGORY[stripMcpPrefix(toolName)] || 'meta';
}

// ─── Agent type → category map ──────────────────────────────────────────────
// Agents are categorized by ROLE, distinct from tool categorization. Source:
// recovered from canonical's pre-merge working tree as a starting point.
const AGENT_CATEGORY = {
  Explore:                 'runtime',
  Plan:                    'orchestration',
  Bash:                    'runtime',
  'general-purpose':       'fileio',
  'statusline-setup':      'meta',
  'claude-code-guide':     'fileio',
  'research-analyst':      'runtime',
  'security-specialist':   'orchestration',
  'performance-analyst':   'runtime',
  'compatibility-analyst': 'fileio',
  'pdf-extractor':         'fileio',
  'excel-writer':          'fileio',
  facilitator:             'orchestration',
  supervisor:              'orchestration',
};

/** Resolve an agent type to an IDENTITY palette entry. */
export function getAgentTypeColor(agentType) {
  if (!agentType) return IDENTITY.meta;
  return IDENTITY[AGENT_CATEGORY[agentType]] || IDENTITY.meta;
}

// ─── Tool descriptions ──────────────────────────────────────────────────────
// Used in tooltips and the Tools panel. Each is prefixed with its category
// label so the prefix doubles as a quick-reference legend.
export const TOOL_DESCRIPTIONS = {
  Read:            'File I/O · Reads file contents from disk',
  Write:           'File I/O · Creates or overwrites a file',
  Edit:            'File I/O · Performs exact string replacements in files',
  NotebookEdit:    'File I/O · Edits Jupyter notebook cells',
  Bash:            'Shell · Executes shell commands (git, npm, docker, etc.)',
  WebFetch:        'Network · Fetches and analyzes web page content',
  WebSearch:       'Network · Searches the web for information',
  Glob:            'Search · Finds files by name/pattern',
  Grep:            'Search · Finds file contents by regex',
  Task:            'Orchestration · Spawns a subagent for a complex subtask',
  Agent:           'Orchestration · Subagent performing work in parallel',
  TodoWrite:       'Orchestration · Writes to the task/todo list',
  TaskCreate:      'Orchestration · Creates a new task in the task list',
  TaskUpdate:      'Orchestration · Updates an existing task status',
  TaskList:        'Orchestration · Lists all tasks',
  EnterPlanMode:   'Orchestration · Enters planning mode for complex tasks',
  ExitPlanMode:    'Orchestration · Exits planning mode with a plan',
  Skill:           'Orchestration · Invokes a user-defined skill/command',
  ToolSearch:      'Meta · Discovers and loads deferred MCP tools',
  AskUserQuestion: 'Meta · Asks the user a clarifying question',
};

// =============================================================================
// TYPOGRAPHY
// =============================================================================
// Component-internal text sizes. These tokens are not abstractions over Tailwind
// — they're named pointers to specific Tailwind utility classes so a future
// "scale up the dashboard" effort can ripple through one file.
//
// Use semantic tokens; don't sprinkle bespoke `text-[Npx]` classes in components.

export const FONT = {
  body:    'text-xs',                                          // 12px — default panel content, table rows
  label:   'text-[11px]',                                      // 11px — meta strip values, secondary stats
  meta:    'text-[10px]',                                      // 10px — small uppercase labels
  micro:   'text-[9px]',                                       // 9px  — timeline ticks, badge text
  heading: 'text-xs font-semibold uppercase tracking-wider',   // panel titles
  display: 'text-base font-bold font-mono leading-tight',      // header stats (numbers)
};

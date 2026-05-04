# Dashboard Cheat Sheet

Quick reference for every section in the Session tab, what it shows, and why it matters.

---

## Context Window (Row 1, 9 columns)
**What:** Fill gauge showing how much of the model's 200K token context window is used.
**Why it matters:** When context hits ~95%, Claude auto-compacts (summarizes) the conversation, losing detail. This is your runway indicator.

| Component | Meaning |
|-----------|---------|
| Fill bar | Purple = healthy, amber = >50%, red = >80%. Tick marks at 80% (warning) and 95% (critical). |
| % number | Current context fill percentage. |
| Uncached | Input tokens NOT served from cache — these cost full price. |
| Output | Tokens Claude generated (responses, code). |
| Cache Read | Tokens reused from cache — 90% cheaper than fresh input. High = good. |
| Cache Write | Tokens written to cache for future reuse — costs 25% extra now, saves later. |
| Cache Hit | Ratio of cached vs uncached input. Higher = lower cost per turn. |
| Velocity | Average tokens consumed per turn — predicts how fast you burn context. |
| Turns Left | Estimated turns remaining before hitting the context limit. Red = urgent. |
| Compacted | Badge shown when context was recently auto-compacted (summarized). |

**Performance impact:** High velocity = fewer turns before compaction. Cache hit >90% = cost stays low. Turns left <5 = consider starting a new session.

---

## Models (Row 1, 3 columns)
**What:** Pie chart showing which models are active and their cost share.
**Why it matters:** Subagents automatically use cheaper models (Haiku, Sonnet). If you see only Opus, no subagents were spawned. Multiple models = Claude is delegating work efficiently.

| Component | Meaning |
|-----------|---------|
| Donut chart | Visual cost split. Purple = Opus, blue = Sonnet, cyan = Haiku. |
| Model rows | Name + cost for each model used. |
| LIVE badge | Data comes from real-time hooks (not file parsing). |

**Performance impact:** Opus costs ~5x Sonnet, ~19x Haiku. Heavy Opus usage = expensive session. Subagent delegation to Haiku/Sonnet keeps costs down.

---

## Performance (Row 2)
**What:** CLI terminal rendering metrics — how smoothly the Claude Code UI draws.
**Why it matters:** Slow rendering = laggy terminal experience. Usually not actionable but helps diagnose if Claude Code feels sluggish.

| Component | Meaning |
|-----------|---------|
| FPS | Frames per second — higher is smoother. Typical: 30-60. |
| Frames | Total screen redraws during the session. |
| p50 | Median frame time — half of frames render faster than this. |
| p95 | 95th percentile — only 5% of frames are slower. Amber = slightly elevated. |
| p99 | 99th percentile (tail latency) — worst-case frame times. Red = high latency spikes. |
| Range | Min-Max frame duration. Wide range = inconsistent rendering. |

**Performance impact:** p99 > 50ms = visible lag. Usually caused by large tool outputs or complex renders. Not something you control directly.

---

## Turn Heartbeat
**What:** Real-time strip showing tool activity within the current turn, plus the user-waiting idle period after Stop fires.
**Why it matters:** Shows what Claude is actually spending time on. Distinct visual states tell you whether Claude is running tools, "thinking" without tools, or waiting on you.

| Component | Meaning |
|-----------|---------|
| Colored block | Tool execution. Color = tool category (blue=File I/O, cyan=Shell/Network, purple=Orchestration, gray=Meta). Width ∝ duration. |
| Purple top stripe (3px) | Tool fired inside a subagent thread (event has `agentId`). Stripe sits over the tool's category color so you can still tell what tool ran. |
| Dark gap | LLM "thinking" — no tool running, turn still active. |
| **Blue fill** | User-waiting idle — the turn ended (Stop fired), session is awaiting the next user prompt. Blue matches the idle session dot, so "blue dot mode" reads consistently. (Suppressed if tool events have arrived since Stop — auto-mode and forced-continuation cycles still read as active.) |
| **Amber vertical line** | Compaction event — the conversation was auto-summarized at this point. Loss of detail downstream. |
| **Red vertical line + ▼** | Layer 3a Stop-hook rejection forced Claude to retry. Tooltip names the first tool of the forced continuation. Multiple in close succession = supervisor loop. |
| **Dashed vertical line** | Model switch event. Color of the line is the *destination* model's family color (purple Opus / blue Sonnet / cyan Haiku). |
| Green vertical line | Live playhead (current time). |
| Last tool badge | Color dot + tool name shown next to "TURN HEARTBEAT" — the most recently fired tool. |
| Right-side stats | Elapsed turn time · tool execution time · model time (everything not a tool) · tool call count. |

**Performance impact:** Persistent dark gaps within an active turn = LLM is generating output or waiting on a subagent. Long blue idle = session has been parked between prompts; counts against wall-clock duration but not against working time.

---

## Tools (Row 3, 7 columns)
**What:** Live feed of every tool call Claude makes, with timestamps and success/failure status.
**Why it matters:** This is your real-time view of what Claude is doing right now. Watch for failed tools, validation blocks, and unexpected tool choices.

| Component | Meaning |
|-----------|---------|
| Timestamp | When the tool was called (HH:MM:SS). |
| Green dot | Tool call succeeded. |
| Red dot | Tool call failed (check the error message). |
| Amber dot | Blocked by validation (PreToolUse hook caught a bad command). |
| Tool name | Color-coded: blue=Read, green=Write, amber=Edit/Web, red=Bash, cyan=Search, purple=Agent. |
| Summary | Tool arguments — file path, command, search pattern, etc. |

**Performance impact:** Blocked tools (amber) mean the supervisory layer caught Claude using the wrong tool (e.g., `cat` instead of Read). Failed tools (red) may cause Claude to retry, burning extra tokens and cost.

---

## Turn Cost Chart (Row 3, 5 columns, top)
**What:** Bar chart of cost per turn over the last 20 turns.
**Why it matters:** Identifies expensive turns — large code generation, long tool chains, or agent spawning. Red dashed lines mark compaction events.

| Component | Meaning |
|-----------|---------|
| Purple bars | Cost of each turn in USD. Taller = more expensive. |
| Red dashed lines | Context compaction happened here — conversation was summarized. |
| Tooltip | Hover for exact cost per turn. |

**Performance impact:** Sudden cost spikes often mean Claude is generating large amounts of code or running many tools in one turn. Compaction lines show where context was reset.

---

## Agents (Row 3, 5 columns, bottom)
**What:** Live tracker of subagents — parallel workers Claude spawns for complex tasks.
**Why it matters:** Agents run in parallel using cheaper models. Watching them helps you understand what Claude is delegating vs doing directly.

| Component | Meaning |
|-----------|---------|
| Active count | Number of currently running subagents (cyan). |
| Done count | Total completed subagents. |
| Green pulsing dot | Agent is actively running. |
| Gray dot | Agent completed. |
| Type label | Color-coded: cyan=Explore (search), purple=Plan (architecture), red=Bash (commands), blue=general-purpose (research). |
| Model | Which model the agent uses (Haiku, Sonnet — cheaper than Opus). |
| Elapsed/Duration | How long the agent has been running or took to complete. |
| Description | What the agent was asked to do. |
| Expand arrow | Click completed agents to see their full result text. |

**Performance impact:** Many concurrent agents = fast parallel work but higher total cost. Long-running agents may indicate complex searches. Agents using Haiku are ~19x cheaper than the main Opus session.

---

## Turns (Row 4)
**What:** Per-turn cost and velocity metrics.
**Why it matters:** Tracks spending rate and predicts when you'll hit context limits.

| Component | Meaning |
|-----------|---------|
| Turn | Number of completed Claude responses. |
| Last | Cost of the most recent turn. Green = normal, red = >2x average (expensive). |
| Avg | Average cost per turn — your baseline spending rate. |
| Velocity | Tokens per turn — how fast context is being consumed. |
| Remaining | Estimated turns left before hitting context limit. Red <3, amber <8. |

**Performance impact:** Rising "Last" costs suggest Claude is doing more work per turn. "Remaining" dropping fast = compaction incoming. High velocity with low remaining = wrap up or start a new session.

---

## Session (Row 5)
**What:** Summary stats for the current session — model, cost, duration, lines changed.
**Why it matters:** Quick glance at session totals. Lowest priority section.

| Component | Meaning |
|-----------|---------|
| Model | Primary model (usually Opus). Purple = Opus. |
| Cost | Total estimated API cost in USD. |
| Last | Cost of the last completed turn. |
| Turn | Total turn count. |
| Duration | Wall-clock time since session started. |
| Tools | Total tool calls tracked. |
| Last Tool | Most recent tool used. |
| Agents | Number of active subagents (if any). |
| Lines | Lines added/removed by Claude (+added/-removed). |

---

## Current Prompt (Row 6)
**What:** The question or instruction Claude is currently answering.
**Why it matters:** Confirms Claude is working on what you asked. Also shows the last completed prompt for context.

| Component | Meaning |
|-----------|---------|
| Active (green dot) | Claude is currently processing this prompt. |
| Completed (gray dot) | Claude finished this prompt. |
| Prompt count | Total prompts submitted this session. |
| Prompt text | Click to expand/collapse long prompts. |

**Note:** Requires the UserPromptSubmit hook. Not available in all environments (Desktop app, some CLI versions). Shows "not available" message when unsupported.

---

## Color Reference

| Color | Meaning |
|-------|---------|
| Purple (#8b5cf6) | Opus model, primary highlights, agents, **subagent stripe in heartbeat**, **dashed marker on Opus switch** |
| Blue (#60a5fa) | Sonnet model, input tokens, idle sessions, **user-waiting idle fill in heartbeat**, **dashed marker on Sonnet switch** |
| Cyan (#22d3ee) | Haiku model, cache tokens, active counts, **dashed marker on Haiku switch** |
| Green (#34d399) | Live/processing, output tokens, success, cost values, heartbeat playhead |
| Amber (#fbbf24) | Cache write, warnings, validation blocks, elevated latency, **compaction marker in heartbeat** |
| Red (#f87171) | Errors, failures, critical context, high latency, expensive turns, **forced-continuation marker in heartbeat** |

---

## Quick Decision Guide

| Signal | Action |
|--------|--------|
| Context >80% | Consider wrapping up the task or starting fresh |
| Context >95% | Compaction imminent — detail will be lost |
| Turns Left <5 | Urgent: finish current work or start new session |
| Red tool dots appearing | Check error messages — Claude may be struggling |
| Amber tool dots appearing | Supervisory layer blocked a bad tool choice — working as intended |
| Cost spike in Turn Cost Chart | Claude did heavy work — check if intentional |
| Many agents active | Parallel delegation — efficient but watch total cost |
| Cache Hit <50% | Unusual — may indicate conversation pattern changes |
| Velocity increasing | Context being consumed faster — fewer turns remaining |
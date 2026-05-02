---
description: "Context window monitoring thresholds and required disclosure actions"
---

# Context Discipline

## Monitoring Thresholds

| Context Used | Required Action                                                                    |
|-------------|------------------------------------------------------------------------------------|
| > 50%       | Note internally; avoid starting new large tasks                                    |
| > 70%       | Inform user: "Context at ~70%. Recommend finishing current task then new session." |
| > 85%       | Stop taking new work. Complete only current task. Strongly recommend new session.  |
| > 95%       | Halt all new work. Inform user. Do not start anything.                             |

How to estimate: run `/telemetry context` — report as **#compactions** and **% of context window used**. Compaction is detectable via 500%+ cumulative token ratio.

## Prohibited at > 70% Context

- Beginning any multi-file read task
- Beginning any consolidation or synthesis document
- Dispatching subagents for large work (they inherit compressed context)
- Declaring any multi-source task "complete" without source verification

## Compaction Detection

If cumulative session tokens show > 500% of context window size, compaction has occurred.
State explicitly: "Context compaction occurred mid-session. Work done before compaction
cannot be verified as complete without re-reading source files from scratch."
Do NOT present pre-compaction work as reliably complete.

## After Compaction

- Treat all prior summaries and in-memory notes as suspect
- Re-verify by reading files, not by recalling summaries
- If task cannot be safely completed in remaining context: stop and plan a new session

---
description: "Context window monitoring thresholds and required disclosure actions"
keywords: [context, tokens, remaining, threshold, compaction, telemetry context, headroom, disclose, /telemetry]
severity: warn
---

# Context Discipline

## Monitoring Thresholds

Thresholds are expressed as **remaining tokens**, not percentages, so they apply correctly
across all model sizes (e.g., ~200K windows on Sonnet/Haiku and ~1M windows on Opus 4.7).

**Measure before acting — never estimate or guess.** Run `/telemetry context` to get the
actual remaining token count. Do not infer context pressure from message length, turn count,
or a felt sense of "this is getting long." Guessing a percentage and acting on the guess is a
policy violation.

| Remaining tokens | Required Action |
|---|---|
| < 150,000 | Note internally; avoid starting new large tasks |
| < 80,000 | Inform user: "Remaining context is low (~80K tokens). Recommend finishing current task then starting a new session." |
| < 40,000 | Stop taking new work. Complete only current task. Strongly recommend new session. |
| < 15,000 | Halt all new work. Inform user. Do not start anything. |

## Prohibited below 80,000 remaining tokens

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

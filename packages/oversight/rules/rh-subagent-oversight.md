---
description: "Standard instructions for dispatching and trusting subagent results"
---

# Subagent Oversight

When dispatching any subagent that reads multiple items (files, URLs, records), append these requirements to the agent prompt:

## Required in agent prompt

1. **Verification tokens**: For each item processed, return a provable artifact that demonstrates completeness — for files: the literal **last line** of the file plus total line count and the line range actually read (e.g., "lines 1–639 of 639"); for non-file sources (URLs, records, API responses): a unique identifying string copied verbatim from a section near the end of the source. Do not paraphrase.

2. **Self-reported telemetry**: End your response with:
   - Items found / successfully processed / failed or truncated (list any failures)
   - Context usage: **#compactions** and **% of context window used**
   - If **> 85% used**: STOP immediately — do not process further items. Return results so far and remaining count. This is a failure condition, not a warning.

3. **Batch overflow rule**: If after processing the first item you can tell the full task will exceed your capacity, STOP and return only the first item's result plus the total count of remaining items. Do not attempt the full set.

4. **Count cross-reference**: Report the total number of items found at the source so the parent can verify against an independent count. If counts disagree, the result is suspect.

## Trust policy

- If a subagent reports context usage "high" or "critical," treat output as suspect — redispatch in smaller batches.
- If a subagent's item count disagrees with an independent count (e.g., `ls | wc -l`), redispatch.
- Never burn primary-agent context on verification reads. If spot-checking is needed, dispatch a second subagent.

## Cross-Subagent Conflict Detection

When two or more subagents in the same session return values for the same factual field (attribution, classification, count, amount), compare their values before acting on either.

If the values disagree:
1. STOP — do not present either value to the user yet.
2. State the conflict explicitly in your next message: "Subagent A reported X; subagent B reported Y on the same field."
3. Dispatch a tiebreaker subagent with a narrow prompt reading the exact source line, with a verification token.
4. Only after the tiebreaker resolves the conflict, present the resolved value with the token.

This rule applies specifically to:
- K-1 box attributions (passive vs. nonpassive, recourse vs. nonrecourse)
- Row/entity labels on multi-row schedules
- Page counts and file lengths
- Dollar-amount attributions across entities
- Any field that could drive a downstream decision

Never silently pick one subagent's answer over another when they disagree. Never average them. Never omit the conflict from your status to the user.

## Scope note — ScheduleWakeup

ScheduleWakeup resumes the same conversation thread; it is **not** a subagent dispatch. The four-item protocol (verification tokens, self-reported telemetry, batch overflow rule, count cross-reference) does not apply to ScheduleWakeup payloads.

However, resumed turns must still:
- Disclose context pressure per `rh-context-discipline.md` (>70% inform, >85% stop, >95% halt).
- Surface between-cycle improvement signals per `~/.claude/memory-shared/feedback_iterate_between_pipeline_cycles.md` — don't run cycle N+1 with stale params; explicit between-cycle improvement step required.

Also note: the `rh-agent-oversight-guard.js` PreToolUse hook matches the `Agent` tool only. ScheduleWakeup invocations are not policed by it.

## Scope: Direct Reads in Main Context

These same standards apply when reading files directly (not via subagent) in any consolidation or source-attribution task:

- Files > 800 lines MUST be dispatched to a subagent with the oversight protocol — do not Read them directly in main context
- Before using any Read result in synthesis, confirm the read was complete: did the file have more lines than were returned?
- A file read in main context still requires a verification token (literal last line) plus total line count and line range actually read before it can appear in a source registry

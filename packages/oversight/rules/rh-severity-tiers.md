---
description: "Severity vocabulary for oversight signals — note / warn / block — and budget thresholds for loop-break"
keywords: [severity, note, warn, block, loop-break, budget, threshold, layer-3a, supervisor]
severity: note
---

# Severity Tiers

## Principle

Oversight signals (rule frontmatter, supervisor verdicts, hook outputs) use a shared three-level severity vocabulary so the system can apply different responses without re-deriving the meaning each time.

## The three tiers

| Tier | Meaning | Action |
|---|---|---|
| `note` | Advisory only. Worth surfacing for awareness; never blocks Claude's turn. | Append a one-line surfacing to the rejection or output; do NOT count toward loop-break or warning budgets. |
| `warn` | Significant issue. Surface prominently to the user; counts toward warning budget. | Surfaced inline; if `warn` budget exceeded within a session, escalate to forced user input. |
| `block` | Hard blocker. Exit 2 from the hook; force Claude to retry with rejection in context. | Counts toward loop-break (current threshold: 3 consecutive blocks → loop-break defers to user). |

These match ESLint's `off`/`warn`/`error` and RuboCop's severity ladder; the vocabulary is borrowed deliberately.

## Where severity appears

1. **Rule frontmatter** — every workspace rule declares its default severity:
   ```yaml
   severity: warn   # default response when a violation of this rule is detected
   ```
   Current settings (workspace rules, 2026-06-01):
   - `block`: `rh-completion-standards`, `rh-security`, `rh-source-or-stop`, `rh-work-verification`
   - `warn`: `rh-context-discipline`, `rh-conventions`, `rh-input-parsing`, `rh-read-integrity`, `rh-replacement-assessment`, `rh-subagent-oversight`, `rh-tool-selection`, `rh-cwd-awareness`, `rh-rule-consultation`
   - `note`: `rh-oversight-doc-sync`, `rh-severity-tiers` (this file)

2. **Supervisor verdicts** — the Layer-3a Stop-hook supervisor today returns `{ok: true}` (allow) or `{ok: false, reason: ...}` (block). Supervisor v2 (plan §5.2, not yet built) will extend to all three tiers via `{ok: false, severity: "note"|"warn"|"block", reason: ...}`.

3. **Hook outputs** — hooks emit `oversight_events.jsonl` entries with `event_type` carrying the severity (e.g., `layer3a_note`, `layer3a_warn`, `layer3a_block`). Today's events are predominantly the block-equivalent `layer3a_rejection` because v1 supervisor only has the two-tier output.

## Budget thresholds

| Budget | Threshold | Action when exceeded |
|---|---|---|
| Consecutive `block` events (same session) | 3 in a row without user intervention | Loop-break: supervisor returns `{ok: true, reason: "loop-break..."}` and defers to user |
| Same-reason `block` repeated (same session) | 2 consecutive with substantively-identical rejection text | Loop-break: rejection isn't producing correction, defer |
| `warn` events (per session) | 5 total | Forced user input — escalate to user before more work |
| `note` events (per session) | No threshold | Pure information; surface inline |

## How severity is set vs. computed

- **Rule-default severity** comes from the rule's frontmatter `severity:` field. This is the *default* when a violation is detected without further context.
- **Per-violation severity** can be elevated by the supervisor if the violation has high stakes (e.g., a `warn`-severity rule violated in a way that risks data loss may be raised to `block`). Demotion in the other direction is allowed but rarer.
- **Severity != certainty.** A `block` verdict means "stop and address," not "the supervisor is 100% sure." Supervisor v2's adversarial framing (plan §5.2) is about calibrating certainty, separate from tier choice.

## Failure modes this rule mitigates

- **All-or-nothing supervisor responses** — without tiers, every false positive that survives Layer-3a contributes to loop-break, and every true positive without retry budget gets lost.
- **Silent overrides** — `note` is documented so low-precision rules can surface without polluting the block budget.
- **Premature loop-break** — explicit thresholds prevent loop-break from firing on accumulated warnings vs genuine block repeats.

## What this rule does NOT cover

- The supervisor implementation itself (v1 today, v2 proposed in plan §5.2). This rule defines the vocabulary; the implementation conforms (or doesn't, in which case the implementation needs to evolve).
- The specific severity of any given rule's violations. Each rule's `severity:` frontmatter governs its own default.
- Per-project severity overrides. Currently no mechanism; if needed, a project-level `.claude/severity-overrides.json` could be added later.

## Origin

Plan §5.4 proposal + the 2026-06-01 redesign session. Codified ahead of supervisor v2 build (which is on hold pending B2 outcome data) so the vocabulary is shared and stable before any implementation depends on it.

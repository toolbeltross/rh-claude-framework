---
description: "Qualifies ADDITIVE ONLY-style rules: removal/replacement requires a brief written assessment; fact corrections are exempt"
keywords: [ADDITIVE ONLY, replacement, removal, replace, drop, fact correction, assessment, value lost, value gained, refactor, deprecate]
severity: warn
---

# Replacement Assessment

> Generalizes the qualification across any project that has an ADDITIVE ONLY-style rule.

## Principle

**Default: only add.** When a project's CLAUDE.md or rule body forbids removal of working functionality (an "ADDITIVE ONLY"-style rule), the spirit is preserved: don't replace working things with untested ones, don't drop established decisions without a record.

**Qualification: when removal or replacement is being considered, a brief written assessment is required first.** This unblocks the case where ADDITIVE ONLY would otherwise force accumulation of stale or wrong content.

## Required assessment (when applicable)

Before removing or replacing anything that an ADDITIVE ONLY-style rule covers, write down:

- **What** — the specific element being removed or replaced (file, function, hook entry, configuration line, agent definition, etc.).
- **Evidence** — what motivates the removal? Cite an incident ID, audit finding, observed regression, oversight-events.jsonl event_type, PLAN-*.md item ID, or supervisor finding. "It would be cleaner" is not evidence.
- **Value lost** — what existing callers, decision lineage, or recovery paths disappear if this is removed?
- **Value gained** — what correctness, maintainability, or cost benefit is unlocked by replacing it?
- **Recommendation** — keep / replace / add-alongside-and-deprecate / something else.

This assessment can live in the commit message, the PR description, the relevant PLAN-*.md item, or a one-paragraph note in the same edit. Format is flexible; presence is required.

## Carve-out: fact corrections are not removals

If a statement is factually wrong — a feature described as "(future)" that has shipped, a Known Issue that has been resolved, a version number that is outdated, a file path that has been renamed, a count that has drifted — correcting the wrong statement does **not** require a removal assessment.

**The test:** is the thing being removed *functionality or a deliberate decision*, or is it *a false statement about the current state*?

- *Functionality / deliberate decision* → assessment required.
- *False statement about current state* → fact correction; no assessment required.

**Edge case — functional artifact with a wrong description:** if a system artifact is functional but its *description* is wrong (e.g., a hook entry whose inline comment says "fires in CLI only" when it actually fires everywhere; an agent definition whose docstring claims a tool it doesn't have), the fact correction applies to the description only — not to the artifact. Correct the comment or doc text; preserve the artifact. Removing the artifact based on the wrong description is a removal, not a fact correction, and requires assessment.

Examples of fact corrections (no assessment needed):
- "Stop agent hook (future)" → "Stop agent hook (schema supported, parked on cost)" — feature shipped; description was wrong.
- "Drift since 2026-04-15 due to telemetry bug" → past-tense + reference to fix — incident resolved; description was stale.
- "tool-validator.js" → "tool-validator-v2.js" — file renamed; reference was stale.

Examples of removals/replacements (assessment required):
- Dropping a hook entry from `~/.claude/settings.json` because it "doesn't seem to do anything in this environment." (See `feedback_cross_env_hooks.md` — settings.json is shared across many environments.)
- Replacing a working data path with a different one because the new one looks cleaner.
- Removing an agent definition because it hasn't been invoked recently.
- Refactoring shared infrastructure (lib/, scripts/) where the old shape is the documented interface.

## Interaction with adjacent rules

- **`work-verification.md`** — outer-seam verification still applies after a removal/replacement lands. Assessment is *before* the change; verification is *after*.
- **`oversight-doc-sync.md`** — if the removal/replacement touches an oversight trigger surface, sync the design doc per that rule. The assessment can include the sync plan as one of its bullets.
- **`subagent-oversight.md`** — when the removal proposal comes from a subagent's analysis, apply the cross-subagent verification rule before acting. Don't remove based on a single subagent's finding without source verification.
- **Project-level ADDITIVE ONLY rules** — this workspace rule does not override project rules; it qualifies the meta-pattern. Each project still owns its own rule text. When a project's rule and this rule both apply, both apply.

## What this rule does NOT cover

- Stylistic preferences (which side of the if-clause to negate, which order to declare imports). These don't engage ADDITIVE ONLY in the first place.
- New additions. Adding to existing functionality is the default mode and needs no assessment.
- Verification of whether the removal worked after it lands — that's `work-verification.md`'s job.
- Domain decisions in project work (e.g., dropping a project-specific spreadsheet column). Project plans govern those.

## Failure modes this rule mitigates

- **Silent drift to "replace"** when ADDITIVE ONLY would have been the right call: assessment forces the proposer to articulate value lost.
- **Stale-content accumulation under strict ADDITIVE ONLY**: the carve-out lets fact corrections proceed without the assessment template overhead.
- **Loss of decision lineage**: the assessment captures *why* a removal happened, so a future session reading the docs / commits / plans can reconstruct intent.

## Origin

Triggered 2026-04-25 by a session where three stale lines in `claude-telemetry/CLAUDE.md` (lines 29, 45, 418) needed correcting from "(future)" to current state. ADDITIVE ONLY's literal reading would have forbidden the edit. The session paused, dispatched the oversight-steward, received APPROVE-WITH-CONDITIONS, and the carve-out was articulated as the missing piece. This rule encodes that decision so the next session doesn't have to re-derive it.

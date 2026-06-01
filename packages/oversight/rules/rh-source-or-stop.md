---
description: "When primary source access is blocked, stop and escalate — never silently pivot to alternates"
keywords: [primary source, Figma, MCP, escalate, pivot, fallback, training-data, prior-art, vocabulary-invention, transient error, 401, 403, 404, 429]
severity: block
---

# Source-or-Stop Invariant

> **Provenance**: added 2026-05-28 in response to a documented incident in `rh-platform-agentbuild` (PR #29 + PR #30) where two full deliberation rounds ran on a verbatim "no Figma mock exists" claim that the agent never verified. Root cause was a silent source-pivot: when Figma was harder to access than the PRD, the agent (and the panel) substituted PRD-derivation instead of stopping and escalating. The user's verbatim corrective direction: *"Next time you need to stop if there is a problem accessing the figmas and get with me rather than changing the approach."* This rule generalizes that invariant.

## The invariant

When any agent encounters a barrier to accessing the **primary source** that a deliberation requires — including but not limited to:

- Figma MCP authentication failure
- API rate limit
- Metadata returning unexpectedly empty
- File / mock not yet delivered
- Source file inaccessible / unreadable
- Tool blocked / failing

— it MUST stop the current work and escalate to the user via its return message with: (a) the specific failure mode, (b) the slice / unit it was working on, (c) what it tried.

It MUST NOT pivot to alternate sources — including PRD-derivation when the primary is Figma, prior-art assumption, training-data defaults, vocabulary-invention, or any other "make-do" substitute — **without explicit user direction**.

## Escalation threshold (transient-error tolerance)

A single failed access attempt counts as a barrier. **One retry on transient errors is permitted** before the stop-and-escalate obligation activates. Transient errors are:

- Network timeout
- Rate-limit `429`
- Connection reset (`ECONNRESET` and similar)
- Service-temporarily-unavailable `503`

After one retry, if still blocked, stop-and-escalate.

Non-transient errors (`401` / `403` authentication, `404` not-found, returns-empty-when-it-should-not, blocked-by-classifier) skip the retry and stop-and-escalate immediately.

## In-session user direction

Explicit user direction may be given in the current session conversation — it does NOT require a rules edit, an issue, or a PR. If the user says "use the PRD for this slice" or "skip Figma for this one, just sketch it," that direction covers the slice in question only and does not generalize to other slices.

When such direction is given, record it in the deliberation file as a User Resolution row with the user's direction quoted and dated.

## What "primary source" means

Each project defines its primary-source mapping (which source is primary for which deliberation type) in its own project-scoped rule file. This workspace rule encodes the invariant; the project rule encodes the mapping.

In the absence of a project rule, the deliberation's dispatch context names the primary source. If neither exists, the deliberation cannot proceed — stop and ask the user to clarify primary source.

## What is NOT covered by this rule

- **Optional / supplementary sources**: if a panelist consults `~/.claude/memory-shared/` for general patterns and finds nothing relevant, that's a non-event — `memory-shared` is supplementary, not primary.
- **Cross-PRD consistency reviews**: when checking PRD-vs-PRD consistency and one PRD is silent, that's an Open Question (per `rh-subagent-oversight.md`), not a stop-and-escalate event.
- **Vocabulary-cascade reads**: when the vocabulary cascade lands on "panelist-invention" tier because higher-priority sources didn't define the term, that's the cascade's designed behavior, not a stop-and-escalate event.

## Source-adequacy interaction with `rh-read-integrity.md`

`rh-read-integrity.md` already requires that source-adequacy match the claim — counting CSS declarations doesn't answer how many distinct font sizes the rendered DOM produces, and counting agent files on disk doesn't answer which agents actually loaded. **This rule complements that**: when an agent recognizes that source-adequacy requires a primary source it can't access, the right move is stop-and-escalate, not "use what I have."

## Failure-to-rule mapping

This rule mitigates the failure pattern: **silent source-pivot when primary source is harder to access**. Specifically:

- Substituting PRD for Figma (the 2026-05-28 incident — rh-platform-agentbuild)
- Substituting training-data shadcn defaults for design-system primitives
- Substituting prior-PR shapes for current-spec evidence
- Filling silence with invention rather than escalating

## When this rule is violated

A violation is: agent X completed work that depended on primary source Y but never attempted Y access OR attempted Y, got blocked, and continued without surfacing the block. The supervisor and steward should be notified per the standard oversight protocol. Where applicable, the work product is suspect and should be re-evaluated.

---
description: "Keep oversight-system design doc in sync when oversight code changes"
---

# Oversight Documentation Sync

> Pattern adopted from `Diviner-Dojo/agent_framework_template/.claude/rules/framework_doc_sync.md` (2026-04-25). Adapted for the workspace's two-layer (design doc + auto-generated state doc) oversight artifacts.

When changes touch any of the **oversight-defining surfaces** below, the corresponding design-doc sync points must be reviewed and updated in the same session.

## Trigger surfaces

| Surface | What lives here |
|---|---|
| `~/.claude/scripts/` | Oversight enforcement scripts (consolidation-guard.js, agent-oversight-guard.js, agent-result-guard.js, read-audit.js, layer3a-capture.js, oversight-self-test.js, generate-state-md.js, daily-regen.js, lib/oversight-events.js) |
| `~/.claude/agents/` | Agent definitions used by the workspace (supervisor.md, source-verifier.md, facilitator.md, etc.) |
| `Workspace/.claude/rules/` | The 9 workspace rule files |
| `~/.claude/settings.json` | Hooks configuration (PreToolUse / PostToolUse / Stop / SessionStart / etc.) |
| Telemetry hook-forwarder script | Cross-environment telemetry forwarder used by the oversight feed |

## Sync targets

When the trigger fires, review and update these artifacts in the same session:

| Artifact | Path | What to update |
|---|---|---|
| Oversight design doc (hand-authored) | `<oversight-dir>/OVERSIGHT_SYSTEM.md` | Failure-to-mitigation table, layer descriptions, hook list, agent list, rule list |
| Oversight state doc (auto-generated) | `<oversight-dir>/OVERSIGHT_STATE.md` | Re-run `node ~/.claude/scripts/rh-generate-state-md.js` |
| Plan / progress document (if a plan is in flight) | Project plan files | Mark the related item with verification token |

## Sync points (which design-doc section maps to which surface)

| Trigger | Section in OVERSIGHT_SYSTEM.md to review |
|---|---|
| New script in `~/.claude/scripts/` | "Hooks Active" / "Layer N enforcement" |
| Edit to existing guard script's behavior | Failure-mode mitigation table (does this still close the failure it's listed under?) |
| New agent in `~/.claude/agents/` | "Oversight-Related Agents" |
| New rule in `Workspace/.claude/rules/` | "Rules In Place" + the failure-to-rule mapping |
| New hook entry in `settings.json` | "Hooks Active" |
| Telemetry / event-type addition (e.g., new oversight_events.jsonl event_type) | Supervisor data sources section |

## Enforcement

- **In-session manual**: Before declaring oversight-system work "done," verify the corresponding sync target was updated. The work-verification.md "outer-seam" rule applies — a hook script change is not done until the design doc reflects it.
- **Daily regen**: `daily-regen.js` re-runs `generate-state-md.js`, which captures the *current state* (rule/hook/agent inventory). The state doc is self-healing; the design doc is not.
- **Self-test soft check**: `oversight-self-test.js` may include an mtime sanity check — if any trigger surface is newer than `OVERSIGHT_SYSTEM.md`, emit a soft warning (not a hard fail).

## What this rule does NOT cover

- Content accuracy of the design doc (author's responsibility).
- Per-project CLAUDE.md updates (project-scoped, not oversight-system).
- Decision-lineage entries — those go in DECISIONS.md or PLAN-*.md, not the design doc.

## How to mark "intentionally not yet synced"

If a change to an oversight surface is in-flight and you do not want to update the design doc until the change settles, leave a `⏳ pending design-doc sync` marker in the relevant PLAN-*.md item. The next session that touches the design doc must clear pending markers.

---
description: "CWD determines which Claude Code resources load at session start; misalignment creates silent capability gaps"
keywords: [cwd, working directory, session start, cascade, agents, skills, settings.local.json, walk-up, workspace]
severity: warn
---

# CWD Awareness

## Principle

Claude Code loads different resources depending on the working directory at session start. Misalignment between CWD and the actual work creates silent gaps where Claude appears to have context it doesn't.

## What walks up the directory tree (cascade behavior)

| Resource | Walks up from CWD? | Notes |
|---|---|---|
| `CLAUDE.md` (project + parent + global) | **Yes** | Project CLAUDE.md + parent CLAUDE.md(s) + `~/.claude/CLAUDE.md` all load |
| `.claude/rules/*.md` | **Yes** (workspace rule files in the cascade) | Workspace rules apply across all subproject sessions |
| `.claude/agents/*.md` | **No** | Project-specific agents only load when CWD is inside that project; user-level (`~/.claude/agents/`) always loads |
| `.claude/skills/*.md` | **No** | Same as agents |
| `.claude/settings.json` | Merged at workspace level | Permission rules accumulate; hooks are user-level |
| `<project>/.claude/settings.local.json` | **No** | Project-local permission allowlists load only when the session CWD is inside that project. Measured 2026-06-11: from a workspace-root session, a subproject's `Bash(node *)` and git allow rules never loaded — hundreds of node invocations paid permission-evaluation overhead that an in-project session would have skipped |

The consequence: opening a session from the workspace root means project-specific `.claude/agents/`, `.claude/skills/`, and `settings.local.json` allowlists for subprojects are NOT loaded, even though their CLAUDE.md content is reachable (and may be lazily injected when files there are first touched — lazy injection restores *knowledge* but never *permissions*, and arrives only after the first touch, which may be after the first edit).

## When to change CWD (or proactively read)

1. **At session start, if CWD is upstream of the actual work directory:**
   Either restart with the subproject as CWD, OR proactively read the subproject's `.claude/agents/` and `.claude/skills/` listing so the resources are at least visible in conversation context.

2. **If a task touches a subproject that has its own `.claude/`:**
   Note the missing resources to the user before answering: "Working from CWD X but task is in Y; Y's `.claude/agents/` won't auto-dispatch and its settings.local.json allowlists won't apply. Either switch CWD or I'll work without them."

3. **For oversight-system work specifically:**
   The configured oversight directory (`oversight.json: oversightDir`) is the canonical CWD for changes to the oversight design doc, decision journal, and incident files. Working from elsewhere risks `config.js` auto-detect falling through to the hardcoded fallback (`~/.claude/oversight/`) and producing artifacts in the wrong place. Mitigated by an explicit `oversight.json` (see the installer's merge-preserve behavior), but an empty or clobbered config re-opens the gap.

4. **One session, one CWD:** work spanning multiple project roots cannot capture every project's local loadout — pick the root where the deepest work happens, and accept lazy injection plus permission prompts for the rest. For single-project sessions, start inside the project.

## How to apply

Before answering a task that touches subproject-specific resources:

1. Check current CWD via `Bash(pwd)` or the harness inventory.
2. Check whether the task's target has its own `.claude/agents/`, `.claude/skills/`, or `settings.local.json`:
   `Glob({{target}}/.claude/agents/*.md)` etc.
3. If yes and CWD is not inside `{{target}}`: surface the misalignment to the user, recommend either CWD change or explicit-read fallback.

## Failure modes this rule mitigates

- **Silent project-specific-agent unavailability** — Claude appears to have the agent fleet listed in the project's CLAUDE.md but cannot dispatch them because they didn't load at SessionStart.
- **Path-resolution drift** — auto-detect functions resolve workspace from CWD walk-up; CWD outside the workspace causes fallback to defaults that may be wrong.
- **Permission-overhead blindness** — project-local allowlists silently not applying, so every command pays evaluation overhead (or prompts) the project owner already decided to waive.

## Origin

Captured 2026-06-01 from a session redesign post-mortem (a user mid-session redirect asking "should we be working from the subproject?"). The `settings.local.json` row added 2026-06-11 after an empirical three-CWD loadout comparison.

---
description: "Concurrent Claude Code sessions in one repo must isolate via git worktrees; automated commits must stage only their own files"
keywords: [multi-session, concurrent, git worktree, worktree isolation, shared checkout, branch switch, git add, /rh-quit, staging scope, cross-session contamination]
severity: warn
---

# Multi-Session Isolation

## Principle

A git checkout has exactly one working tree, one branch pointer, and one staging index. When **two or more Claude Code sessions operate in the same checkout concurrently**, they share that mutable state — and one session's `git checkout`/`git stash`/`git add`/`commit` silently changes the ground under the others. Isolate concurrent sessions with `git worktree` so each has its own working tree on its own branch.

## When this applies

- You are starting work in a repo where another Claude session may already be active (another window/tab, a remote-control session, a background automation, or a spawned task that landed in this checkout).
- The trigger is **overlapping mutable state**, not merely "more than one session exists." Two sessions reading different files with no git-branch operations rarely collide; the harm materializes when sessions switch branches, stage, or commit in the same tree.

## The convention

**One git worktree per concurrent session.** Before doing branch-mutating work when another session might share the checkout:

```bash
git worktree add ../<repo>-<task> <branch>      # or: -b <new-branch> <base>
cd ../<repo>-<task>
```

Each worktree has an independent working tree, HEAD, and index. `git status` in one cannot observe another's uncommitted files; a `git checkout -b` in one cannot switch the branch under another.

## Automated commits: stage only what you authored

Any skill or automation that commits on the user's behalf (notably `/rh-quit`'s SESSION_STATE refresh) MUST stage by **explicit named path** — never `git add -A`, `git add .`, or `git add -u`. Run `git status --short` as a preflight; if it lists files the step did not author (another session's uncommitted work in a shared checkout), **leave them unstaged** and name them in the summary so they are visibly left behind, not silently swept into the commit. (This is enforced in `packages/skills/rh-quit/SKILL.md` step 5.)

## Why this rule is `warn`, not `block`

Detecting "another session is touching this same checkout right now" from a hook is inherently racy — the state can change between the check and the action — so a hard PreToolUse block would false-positive on legitimate single-session `git add -A` and erode trust. The enforcement is therefore: this advisory rule + the scoped-staging guarantee in the `/rh-quit` skill. A `note`-severity SessionStart worktree check may be added later if this rule plus the skill scoping prove insufficient (see F-13 deferred condition).

## Failure modes this rule mitigates

Captured as **F-13 · Cross-session shared-worktree contamination** in `OVERSIGHT_SYSTEM.md` (2026-06-14): three concurrent sessions sharing one checkout produced (1) a branch switch under an active session mid-task, (2) another session's uncommitted files appearing in `git status`, and (3) a `/rh-quit` SESSION_STATE refresh sweeping a different session's unreviewed code into `main` via a broad `git add` (PR #84).

## Interaction with adjacent rules

- **`rh-cwd-awareness.md`** — that rule covers which resources load for a given CWD; this rule covers safe concurrent operation within one repo. A per-session worktree keeps CWD stable as well.
- **`rh-replacement-assessment.md` / `rh-work-verification.md`** — automated commits that sweep foreign files bypass the review + outer-seam discipline those rules assume; scoped staging preserves it.

## Origin

2026-06-14 incident (F-13). Codified after a steward review (APPROVE-WITH-CONDITIONS) of cross-session contamination during concurrent context-db work.

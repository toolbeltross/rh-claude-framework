---
description: "Limitations and degraded behaviour when a Claude Code session runs inside a git worktree — especially under OneDrive: gitignored files absent, .git metadata corruption, and CWD-resolved oversight observability misfire"
keywords: [worktree, git worktree, OneDrive, .env, gitignored, node_modules, .git corruption, gitdir, commondir, HEAD, cwd, oversight observability, hooks, telemetry, artifact misfire, main checkout]
severity: warn
---

# Worktree Limitations

## Principle

A `git worktree` is a separate working tree linked to the same repository — it is **not** a self-sufficient clone. It carries only *tracked* files, its git linkage is a handful of small metadata files that can be corrupted (notably by OneDrive), and a session whose CWD is inside it resolves paths and loads resources differently than a session in the main checkout. Treat a worktree as a **degraded environment** and plan around the gaps below. For *when* to use a worktree at all, see `rh-multi-session.md` (concurrency isolation); this rule is the "what breaks once you're in one."

## What a worktree does NOT carry

| Gap | Why | Consequence |
|---|---|---|
| **Gitignored files** — `.env`, `node_modules`, local secrets/config | `git worktree add` checks out *tracked* files only | DB creds / API keys / deps are absent → "can't connect", missing-module errors that **look like outages but are just the missing file** |
| **Project-local `.claude/` not in git** | a worktree gets the *tracked* `.claude/` from the branch, but any gitignored project config under it is absent (same mechanism) | project-local settings that aren't committed don't come along |

> Incident (2026-06-29, `leafletmap`): a "can't connect to the DB" symptom was actually the gitignored `server/.env` not present in the worktree — the `mssql` driver failed with `config.server property is required` *before any network call*, mimicking a VPN/DB outage (TCP :1433 was actually open). It cost real diagnosis time.

## OneDrive + git-worktree metadata corruption (this machine)

OneDrive syncs and locks the link files under `.git/worktrees/<name>/` (`gitdir`, `commondir`, `HEAD`). When they are clobbered:

- git in the worktree fails outright (`fatal: not a git repository (NULL)`), `git worktree list` stops showing it, and **`git worktree repair` cannot rebuild missing core files** — it reports "gitdir unreadable / .git file broken" and gives up. The corruption is effectively **irreparable**.
- **Committed/pushed work is safe** (it lives on the remote) and the working-tree files are intact (source is just a copy). But you can no longer commit, pull, or branch from that worktree.
- The recurring `error: failed to delete '.git/worktrees/...': Permission denied` prune warnings are the **early symptom** — when you see them, the metadata is already being contended.

**Recovery distinction (C1):**
- *Already-committed branch work* → safe on the remote; just move to the main checkout and `git fetch` / `git pull`.
- *In-flight UNCOMMITTED work* in the worktree → its working-tree files are intact on disk, but git can't see them. **You must manually copy those files into the main checkout** (or a fresh worktree) to commit them — there is no `git`-based migration once the metadata is broken.

**Default mitigation:** for OneDrive-synced repos, **prefer the main checkout for branch work** — `git checkout -b <branch>` in the main checkout, edit + commit there, and let any running dev server serve from it. Reserve worktrees for cases that genuinely need concurrent isolation, and expect their git to be fragile.

## Oversight observability in a worktree — PARTIAL, not absent

User-level hooks **do** fire in a worktree; the failure is *misleading/degraded signal*, not absence. Know which level each piece sits at and compensate:

| Oversight element | In a worktree | What to do differently |
|---|---|---|
| **User-level hooks** (`~/.claude/settings.json`: Stop-hook Layer-3a supervisor, `rh-read-audit.js`, telemetry) | **Fire normally** | Nothing — they work |
| **Path-based hook *content*** (e.g. read-audit counting PNG bytes under the worktree `tmp/` as "lines") | **False-positives** | Treat path-based hook output as **suspect** on worktree paths; don't act on a read-audit warning about a binary/PNG path |
| **CWD-resolved artifact writes** (scribe logs `cleanup.md`/`recommendations.md`/`learnings.md`, oversight HTML, `oversight-events.jsonl`) | **Misfire** into the worktree dir instead of the workspace root (the `rh-doc-placement.md` workspace-vs-project trap) | **Resolve these paths from the workspace root explicitly**, not from the session CWD; verify the write landed at the workspace root |
| **git-dependent oversight checks** (`/rh-quit` state refresh, cleanup sweeps, branch reconciliation) | **Break** when the worktree `.git` is corrupt | Run git-dependent oversight steps **from the main checkout** |
| **Helper success reports** (scribe writes) | A worktree CWD + a `~`-path that never expands resolved to a missing parent and the write **silently no-op'd** | **Verify writes landed on disk** — don't trust the helper's `{ok:true}`. This is the F-15 class (see below) |

## How to apply — worktree pre-session checklist (C3)

Before doing work in a worktree:

1. **Enumerate the gitignored files the project needs** (`.env`, and `node_modules` unless you'll `npm install`). Copy them in explicitly from the main checkout — e.g. `cp ../../../server/.env server/.env` (adjust depth) — and **verify the copy succeeded** before running any command that depends on them.
2. **Note in the session / `SESSION_STATE.md`** that the copy-in was done, so a later session in the same worktree knows the state isn't pristine-from-git.
3. **Expect git fragility under OneDrive** — if you see `Permission denied` prune warnings, assume the metadata may corrupt; keep branch work on the main checkout.
4. **Author workspace-level oversight/rules edits from the workspace-root CWD**, not a nested worktree, to avoid path-resolution drift (per `rh-cwd-awareness.md`).

## Interaction with adjacent rules

- **`rh-cwd-awareness.md`** — what loads per CWD (the resource-loading half). This rule adds the worktree-specific *carry gaps* + OneDrive corruption + observability misfire.
- **`rh-multi-session.md`** — *when* to use a worktree (concurrency isolation) + scoped staging. That rule recommends worktrees as the remedy for F-13; this rule documents the limitations of that remedy once adopted.
- **`rh-doc-placement.md`** — the workspace-vs-project artifact-misfire trap the observability section relies on.

## Failure modes this rule mitigates

Captured as **F-16** in `OVERSIGHT_SYSTEM.md` (2026-06-29): a session in a OneDrive-synced worktree hit (1) "can't connect to DB" that was really the gitignored `server/.env` absent in the worktree; (2) total `.git` metadata corruption that made the worktree non-functional for git and unrepairable; (3) path-based hook false-positives and the standing risk of CWD-resolved oversight artifacts misfiring. Work proceeded only by switching to the main checkout.

**See also F-15** (scribe false-success from a `~`-path that never expanded from a worktree CWD) — a specific prior instance of worktree-CWD environment degradation; its fix is in the scribe write path, where this rule's fix is human guidance.

## Origin

2026-06-29. User report: recurring across the workspace — worktrees "aren't capable of refreshing or aren't given access to hooks, rules, config, env `.env`," plus oversight observability/connection concerns; asked to "keep a knowledge of this." Codified after a session-long live example in `leafletmap`. Steward review (rh-oversight-steward) APPROVE-WITH-CONDITIONS (C1–C8 applied).

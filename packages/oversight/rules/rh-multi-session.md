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

## Scoped staging is NOT sufficient on a shared checkout (2026-08-09 amendment)

**Explicit-path staging bounds WHICH files you add. It does not bound WHOSE commit they land in.**

A checkout has **one index and one HEAD**, shared by every session in it. So *any* branch
operation by *either* party re-attributes the other's staged work:

- `git checkout -b <branch>` **preserves the index**. Files another session already staged are
  carried onto your new branch and into your next commit.
- A branch switch also **reverts the other session's uncommitted working-tree edits**, silently.

Observed live on 2026-08-09 between two coordinating sessions, in **both directions inside one
hour**: session A branched and committed 25 files, 23 of them session B's staged work; then
session B's checkout reverted session A's working-tree edits. **Both sessions were staging by
explicit path and both had avoided `git add -A`.** The existing rule above did not prevent it,
because the failure is not in file selection.

### Why `~/.claude` cannot use the prescribed remedy

This rule prescribes `git worktree` isolation. **`~/.claude` cannot use one — it *is* the shared
surface.** Every session reads its scripts, skills, agents and memory from that one path; a
worktree would be a different tree and would not be the live configuration. So the standard
remedy is structurally unavailable exactly where the hazard is highest.

### What to do instead, in a shared checkout you cannot isolate

1. **Announce before any branch operation *or any write that transits the shared working tree*.**
   `git checkout`, `checkout -b`, `switch`, `reset`, `stash` — ping the other live sessions and
   wait for ack. This is the only real mitigation.

   **And any non-git write that replaces a shared file wholesale**: `git show HEAD:<f> > <f>`,
   `git restore <f>`, a scripted save/modify/restore, or an editor writing a whole buffer. These
   touch **neither HEAD nor the index**, so they appear in **no `git status` column** — a session
   dutifully announcing before `checkout` will still do this without a ping. The hazard is any
   write transiting the shared tree, not only operations that move HEAD or the index.
2. **Preflight the index — do NOT clear it.** *(Corrected 2026-08-13; this item used to say
   "clear the index before staging: `git reset` → `git add` → assert." See the third amendment
   below — that instruction was itself the hazard this rule exists to prevent.)*
   Read the index first; if anything is already staged, it is not yours to discard:
   ```bash
   git diff --cached --name-only     # MUST be empty before you stage
   ```
   Non-empty ⇒ a peer has staged work. **Stop and surface it.** Do not reset, do not stage on
   top, do not commit. Staging on top of a foreign index is how their work enters your commit.
3. **Assert the staged count before committing:**
   ```bash
   git diff --cached --name-only            # preflight — MUST be empty
   git add <explicit paths>
   git diff --cached --name-only | wc -l    # MUST equal your expected count
   ```
   To back out your own staging, unstage **by explicit path** — never `git reset`:
   ```bash
   git restore --staged <your paths>
   ```
   Printing the staged list is not the check — *comparing it to an expectation* is. A session
   printed its 25-file staged list and read it as confirmation. On its first real use this
   assertion caught a genuine off-by-one (staged 22, expected 23) in the peer session.
4. **Read column ONE of `git status --short`.** `M ` is staged, ` M` is unstaged. Counting total
   dirty lines does not distinguish them, and the staged column is the one that gets committed.

## Third amendment (2026-08-13): the prescribed `git reset` was itself a shared-state mutation

Items 2 and 3 above used to open with `git reset`. **That instruction was the hazard.** `git
reset` with no pathspec clears the *entire* index — and on a shared checkout the index is not
yours. It is safe only if the index is already exclusively yours, and **there is no non-racy way
to check**: any test you run can be invalidated by a peer between the check and the reset.

Demonstrated 2026-08-13, isolated repo, both branches run back to back:

| Action | Staged after | Peer's work |
|---|---|---|
| peer stages `peer.md`, you stage `mine.md` | `mine.md peer.md` | — |
| `git reset` (what the rule prescribed) | *(empty)* | **peer's staging destroyed** |
| `git restore --staged mine.md` | `peer.md` | **intact** |

Peer file *content* survives either way — this is a staging-state loss, not content loss — but a
peer that staged deliberately and finds its index emptied has lost work it believed was captured,
with no signal. Observed live 2026-08-09; it survived on timing alone.

**The replacement is preflight-and-stop, plus scoped unstage:**

- `git restore --staged <path>` is the scoped inverse of `git add <path>`. It is what makes the
  assert-then-abort pattern safe on a shared index.
- A non-empty index at preflight is **not** something to clear. It is a signal to stop.

*Practice note:* this session ran ~7 staging operations across three repos (dotfiles, setup,
framework) using preflight → explicit-path `git add` → count assertion, with
`git restore --staged` on the abort path and **no `git reset` at any point**. Every commit staged
exactly its expected count; foreign dirty files in two of the three repos were left untouched
throughout. The pattern is not theoretical.

### Recovery

**For the index-contamination class** (someone else's staged files rode into your commit):
`git reset --soft HEAD~1` then `git reset` restores the index without losing anyone's content;
re-stage your own paths and force-push **with `--force-with-lease`** if the bad commit was already
pushed to your own branch. Content is not lost — it returns to the working tree unstaged — but
**the other session must be told**, because their work is then in no commit and they may believe
it landed.

### There is one variant where content IS lost outright, and git cannot recover it

The guarantee above does **not** extend to save/modify/restore on a shared file:

```
A: cp FILE -> scratch           # A snapshots the shared file, which holds B's pending rows
A: git show HEAD:FILE > FILE    # B's rows are now absent from disk
B: writes its row to FILE       # B appends to the HEAD version — B's earlier rows already gone
A: cp scratch -> FILE           # A restores its snapshot — B's NEW row is silently destroyed
```

B's write then exists **in no commit, in no index, and in no working tree.** There is nothing to
`git reset --soft` back to, and **B gets no signal at all** — its write appeared to succeed. This
is genuine data loss, not misattribution.

**There is no git-side recovery. The only mitigation is not doing it while peers are live.**

**Safer pattern:** modify the file in place (read → edit → write) rather than replacing it from
HEAD and restoring. If you need to stage only a subset, `git stash push --staged` or a temporary
index via `GIT_INDEX_FILE` avoids touching the working tree at all.

*Reported 2026-08-09 by a session that did exactly this to commit one surgical index row. Nothing
broke, by luck rather than design — no peer wrote to that file during the window. It is recorded
because the rule previously reassured the reader that content could not be lost.*

## Why this rule is `warn`, not `block`

Detecting "another session is touching this same checkout right now" from a hook is inherently racy — the state can change between the check and the action — so a hard PreToolUse block would false-positive on legitimate single-session `git add -A` and erode trust. The enforcement is therefore: this advisory rule + the scoped-staging guarantee in the `/rh-quit` skill. A `note`-severity SessionStart worktree check may be added later if this rule plus the skill scoping prove insufficient (see F-13 deferred condition).

## Failure modes this rule mitigates

Captured as **F-13 · Cross-session shared-worktree contamination** in `OVERSIGHT_SYSTEM.md` (2026-06-14): three concurrent sessions sharing one checkout produced (1) a branch switch under an active session mid-task, (2) another session's uncommitted files appearing in `git status`, and (3) a `/rh-quit` SESSION_STATE refresh sweeping a different session's unreviewed code into `main` via a broad `git add` (PR #84).

## Interaction with adjacent rules

- **`rh-cwd-awareness.md`** — that rule covers which resources load for a given CWD; this rule covers safe concurrent operation within one repo. A per-session worktree keeps CWD stable as well.
- **`rh-replacement-assessment.md` / `rh-work-verification.md`** — automated commits that sweep foreign files bypass the review + outer-seam discipline those rules assume; scoped staging preserves it.

## Origin

2026-06-14 incident (F-13). Codified after a steward review (APPROVE-WITH-CONDITIONS) of cross-session contamination during concurrent context-db work.

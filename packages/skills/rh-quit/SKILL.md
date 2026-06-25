---
name: rh-quit
description: User-triggered scribe drain at session end. Dispatches rh-scribe-multiscope directly via the Agent tool to curate recommendations, cleanup items, and learnings in one LLM pass, then refreshes the project's SESSION_STATE.md current-facts doc if one is present. Use when the user invokes /rh-quit, typically at the end of a session before closing.
---

# rh-quit

User-invoked scribe curation pass. The Stop hook's inline regex extraction (`rh-scribe-prefilter.js`) captures low-fidelity rows to `recommendations.md` and `cleanup.md` on every turn. This skill is the **high-quality LLM path**: it dispatches `rh-scribe-multiscope` directly to curate, dedup, and write richer entries — especially learnings, which inline extraction skips entirely.

**Architecture (rev 2026-05-08, P1-4 follow-up):** the skill dispatches `rh-scribe-multiscope` DIRECTLY via the Agent tool. The supervisor agent is no longer in the path for `/rh-quit`. Prior architecture (skill → supervisor → multiscope) added 400+s of supervisor latency with no value-add — the multiscope agent already handles privacy, sentinel, and triage internally. The supervisor's failure-pattern / advisory roles are unrelated to scribe drain and don't belong on this critical path.

## What this skill does

1. **Read the full session text** — per-turn staging is on by default (P1-3). The multiscope agent should consume the staging file via `node ~/.claude/scripts/rh-scribe-staging-read.js <session-id>` for full-session coverage. Fall back to the 10K-char transcript tail only if staging is explicitly disabled (`oversight.json: scribeStaging:false` or `RH_SCRIBE_STAGING=0`) or no staging file exists for this session.

2. **Detect scribe-worthy content** — apply the same marker regexes from `rh-scribe-prefilter.js` (recommendations, cleanup, learnings) to decide whether to dispatch at all.

3. **Dispatch rh-scribe-multiscope in-process** — use the **Agent tool** (foreground, NOT background) with `subagent_type: rh-scribe-multiscope`. The agent does its own privacy/sentinel checks, categorizes each candidate into recommendations/cleanup/learnings, and writes to all relevant targets in one LLM pass. This is synchronous — the user is waiting. Target completion: <30s if nothing substantive after the agent's own re-triage; <90s for the full write pass.

4. **Refresh the project current-state doc (opt-in by presence)** — if a `SESSION_STATE.md` exists at the project root (the workspace-standard current-facts tracking doc), reconcile and refresh it so it doesn't drift the way an unmaintained progress log does. This is the mechanism that keeps the tracking doc current; without it, the doc only updates when someone remembers to, which is how it goes stale.

5. **Loose-ends sweep** — before declaring "safe to close", verify nothing is left behind that `git status`/`gh pr list` can't see: out-of-git edits (gitignored dirs, `~/.claude/`, non-repo paths), worktrees, branches that `--delete-branch` missed, and the IDE's pending "Create PR" affordance. This exists because "cleaned up" was once declared while a gitignored edit sat unactioned in the IDE source-control panel (F-14).

6. **Resolve session-authored open PRs** — a PR you opened this session must be merged (the default) or explicitly declined by the user before "safe to close." Listing it as an open item is not enough; the model may not self-default to "leave it open." Added 2026-06-15 after a session declared safe-to-close with PR #98 still open, self-labeled "awaiting merge," and the user had to step in.

7. **Config-integrity check (OneDrive / OS)** — run `rh-config-integrity.js` to confirm OneDrive or an OS-level problem hasn't silently broken the config the oversight/telemetry system depends on (cloud-only/dehydrated files, zero-byte config, broken `settings.json` hook references, sync-conflict files). Detect-only — it never repairs; a non-clean result is surfaced to the user with the script's suggested fix. This is the session-end tripwire for the "OneDrive ate a hook script" failure class that the existing self-test / health probes do not cover.

8. **Report what was captured** — print a summary listing files written, items appended, the loose-ends sweep results, open-PR dispositions, the config-integrity result, and confirm "safe to close session."

## Execution steps

When the user invokes `/rh-quit`:

1. **Detect markers in current session's transcript tail:**
   - The transcript is available in the current conversation context (the model can read it directly)
   - Apply the marker vocabulary:
     - **Recommendations**: recommend, should, consider, would be better, improve, suggest
     - **Cleanup**: TODO, FIXME, leftover, stale, cleanup, temporary, orphan, dead code, remove later
     - **Learnings**: learned, established, the pattern is, going forward, new concept, distinguish between, taxonomy, vocabulary, technique, methodology, decision rule
   - Determine which sub-scopes have substantive content (not just marker words in passing)

2. **If no markers found:** print "No scribe-worthy content detected this session. Safe to close." and stop.

3. **If markers found, dispatch rh-scribe-multiscope directly:**
   Use the Agent tool (foreground) with `subagent_type: rh-scribe-multiscope`. Prompt:
   ```
   User-triggered scribe drain via /rh-quit. Sub-scopes with substantive
   content detected: <detected scopes>.

   Read the full session text. First try the staging file:
     node ~/.claude/scripts/rh-scribe-staging-read.js <session_id> --stats
   If `turns > 0`, read the full session text via:
     node ~/.claude/scripts/rh-scribe-staging-read.js <session_id>
   Otherwise fall back to the transcript tail at <transcript_path> (legacy
   10K-char window — only captures the last ~1-2 turns of a long session).

   After successfully writing rows, clear the staging file:
     node ~/.claude/scripts/rh-scribe-staging-read.js <session_id> --clear > /dev/null

   Run your standard single-pass workflow:
     1. Privacy blocklist check — structural patterns (Personal/, Financial/, Divorce) + user-specific entity names from ~/.claude/private-blocklist.json
     2. Self-loop sentinel check (<!-- scribe-done --> in tail)
     3. Categorize each substantive candidate into one of: recommendations,
        cleanup, learnings (tie-break order: cleanup > recommendations > learnings)
     4. Run the per-bucket write phase ONLY for buckets with ≥1 candidate
     5. Cleanup the pending flag

   Session ID: <session_id>
   Inline prefilter may have already captured low-fidelity rows; your job
   is to dedup and add high-quality entries the regex path missed
   (especially learnings).
   ```

4. **Refresh `SESSION_STATE.md` if it exists** (opt-in by presence — skip silently if the project has no such file):
   - Read the project-root `SESSION_STATE.md`.
   - Reconcile its current-facts block against reality:
     - Identify the latest **substantive** merged PR (`git log --oneline` — skip the refresh's own `docs(state):` stamp commits) → update the **Through** line. Do **not** pin a literal commit hash: a stamp commit becomes the new HEAD and would instantly invalidate it.
     - `git log --oneline` since the last-verified stamp → fold any newly-merged work into the picture; do NOT paste the log (git history is authoritative) — only update what changed in the *current* state.
     - Scan open `PLAN-*.md` files for unchecked items → keep the **In-flight / outstanding** table accurate.
     - Update the **Last verified** stamp to today's date (from session context).
   - Keep it lean (< 100 lines). If a section has grown historical, move it to `archive/` rather than letting the file bloat — that bloat is exactly what this convention exists to prevent.
   - This is a curation pass, not a blind append. Only the model can do it well; that's why it lives here and not in a hook.

   **Commit hygiene — REQUIRED if you commit/PR the refresh.** The workspace pattern lands the refresh on a `chore/session-state-refresh-prNN` branch + PR. When you stage:
   - **Stage ONLY the files this step changed, by explicit path** — `SESSION_STATE.md` and any `PLAN-*.md` you actually edited. **Never `git add -A`, `git add .`, or `git add -u`.**
   - **Run `git status --short` as a preflight FIRST.** If it lists files you did not edit in this skill — another concurrent session's uncommitted work in the shared checkout — do **not** stage them. Stage only your named paths and list the foreign dirty files in the summary so they are visibly left behind, not silently swept.
   - **Why:** `/rh-quit` runs at session end, when the working tree may hold a *different* session's in-progress work. A broad add sweeps that unrelated, unreviewed delta into the refresh PR — this is exactly what produced PR #84 (an inert-but-unreviewed context-db delta merged via a `/rh-quit` refresh before its own PR was ready). Scoped, named-path staging is the fix. *(Steward APPROVE-WITH-CONDITIONS C1; oversight failure row F-13.)*

5. **Loose-ends sweep (REQUIRED before declaring "safe to close").** Git/PR commands only see *tracked* state — they cannot see edits in gitignored dirs, `~/.claude/`, or non-repo paths, nor the IDE's "Create PR" affordance. Declaring cleanup from `git status` / `gh pr list` / `git branch` alone is exactly how loose ends slip through (**oversight failure F-14**, 2026-06-14: a `/rh-quit`-adjacent "cleaned up" claim missed a gitignored `OVERSIGHT_SYSTEM.md` edit the IDE was surfacing as `rh-oversight-content +16 [Create PR]`). Run each check and report **resolved or explicitly left, with full paths**, as its own structured section:
   - **Tracked git state** — `git status --short` in every repo you committed to this session; `git log <upstream>..HEAD` for unpushed commits; `gh pr list --state open` for your unmerged PRs. **Any open PR you authored this session is resolved in step 6 — merely listing it here is NOT sufficient.**
   - **Branch deletion** — for each PR you merged with `--delete-branch`, confirm via `git ls-remote --heads origin` (the *server*, not the local `git branch -r` cache, which `git fetch` doesn't prune) that the branch is actually gone; a worktree-pinned local branch makes `--delete-branch` silently fail.
   - **Worktrees** — `git worktree list`; flag any worktree or `.git/worktrees/` admin folder you created.
   - **Out-of-git edits (SELF-REPORTED — not a filesystem scan):** for each directory OUTSIDE a tracked git checkout that *you wrote to this session* (gitignored dirs e.g. `oversight-system/`, `~/.claude/`, non-repo paths), list each file you wrote and state its disposition — **intentional disk-only** (say why it needs no PR) or **needs-commit** (open item). These never appear in `git status`.
   - **DISCLOSURE to the user (NOT a checkbox you can mark resolved):** the IDE source-control panel may surface a pending "Create PR" affordance for gitignored / out-of-repo files you edited this session that no `git` command reveals. You cannot verify or dismiss it from inside the session — tell the user to review the source-control panel before closing.

6. **Resolve session-authored open PRs (REQUIRED — merge-or-decline before "safe to close").** A PR you opened or pushed commits to during this session is *undelivered work*, not a passive loose end. `/rh-quit` MUST NOT self-assign a "leave it open" disposition — that defeats the purpose of the session-end gate. For each open PR you authored this session (`gh pr list --state open --author @me`, cross-checked against PRs you touched):
   - **Default action is to MERGE it.** Once it is verified (tests / outer-seam green) and mergeable (`gh pr view <N> --json mergeable,mergeStateStatus,statusCheckRollup`), merge it — `gh pr merge <N> --squash --delete-branch` (match the repo's merge convention; squash matches recent fix PRs here). Confirm `state: MERGED` afterward.
   - **The ONLY alternative is an EXPLICIT user decline.** If the user says to leave it open (external review pending, CI, genuinely WIP), record that decision **verbatim** in the summary; convert to draft if that's the intent. The model may not infer or default this — it must be the user's stated choice this session.
   - **Do NOT print "safe to close" while a session-authored PR is open without either a recorded merge (with commit SHA) or an explicit user decline.** "Listed as an open item" is NOT sufficient — that was the gap before 2026-06-15 (the model self-defaulted PR #98 to "awaiting merge" instead of merging or asking; the user had to intervene).
   - **Detached-HEAD / worktree-locked-`main` gotcha** (learned 2026-06-15): `gh pr merge --delete-branch` needs a real branch checked out and tries to switch to the default branch afterward. If `main` is checked out in another worktree, that post-merge switch fails. Merge from the PR branch *without* `--delete-branch`, then delete the remote branch (`git push origin --delete <branch>`) and move local off it (`git switch --detach origin/main && git branch -D <branch>`).

7. **Config-integrity check (REQUIRED — alert-only, OneDrive / OS tripwire).** Before printing the summary, verify OneDrive or an OS-level problem hasn't silently broken the config the oversight/telemetry system depends on. Run:
   ```bash
   node ~/.claude/scripts/rh-config-integrity.js
   ```
   It is **detect-only — it never repairs.** It checks six things across the workspace `.claude/`, the oversight-system dir, and `~/.claude/{scripts,agents,skills}`: settings-JSON validity, that every script referenced by `settings.json` hooks exists and is non-empty, OneDrive cloud-only/dehydrated files, zero-byte config files, sync-conflict files, and core-dir presence. Exit `0` = clean, `1` = degraded (warn), `2` = critical.
   - **Exit 0:** note "config integrity: clean" in the summary and proceed.
   - **Exit 1 or 2:** surface the failing probe lines **and the script's `SUGGESTED FIX` block verbatim** to the user as a prominent callout. Do **not** auto-repair and do **not** silently swallow it — a critical result means a hook or rule the live system depends on is missing / cloud-only / corrupt (exactly the OneDrive-compromise failure class this check exists for). The user runs the fix; you only report. This surfaces but does **not** block "safe to close" (the user chose alert-only).

8. **Print summary:**
   - Items appended per scope (recommendations / cleanup / learnings)
   - Whether `SESSION_STATE.md` was refreshed (and what changed) or skipped (not present)
   - **Loose-ends sweep** results (its own section — every item above, resolved or left, with paths)
   - **Open-PR resolution** — each session-authored PR with its disposition (merged + commit SHA, or user-declined quoted verbatim)
   - **Config integrity** — `clean`, or the failing probes + suggested fix surfaced verbatim (alert-only; never auto-repaired)
   - Files modified
   - Confirm **"Safe to close session."** — only after **(a)** the loose-ends sweep is clean or its open items are explicitly listed, AND **(b)** every session-authored PR has been merged or explicitly declined by the user per step 6. A still-open session PR with no recorded decline **BLOCKS** this line.

## What was removed (do not recreate)

The prior architecture used an async queue + detached drain:
- `~/.claude/scripts/rh-scribe-drain.js` — **deleted**
- `~/.claude/scripts/rh-scribe-drain-startup.js` — **deleted**
- `~/.claude/rh-scribe-queue/` directory — **deleted**
- SessionStart drain-startup hook entry — **removed from settings.json**

These had multiple Windows failure modes (OneDrive cwd ENOENT, detached spawn ENOENT, child claude STATUS_CONTROL_C_EXIT). The replacement is inline regex extraction in the Stop hook + this direct-dispatch curation skill.

The prior architecture (rev 2026-05-08 morning) routed `/rh-quit` through the supervisor agent which was supposed to dispatch `rh-scribe-multiscope` via Task. Runtime testing (2026-05-08 afternoon) showed the supervisor inlined the work instead of dispatching, took 416s for a single scribe run, and falsely reported "Task tool not available" despite Task being in its frontmatter and not gated. **Do NOT route /rh-quit through the supervisor.** The supervisor's failure-analysis / session-start-advisory / task-completion-checkpoint roles are valid; scribe orchestration is not its job.

## When to use

- User explicitly invokes `/rh-quit` at the end of a session
- This is the manual finishing move before closing Claude Code

## When NOT to use

- Mid-session — the Stop hook's inline prefilter handles per-turn capture automatically
- If the transcript has no markers — just confirm "nothing to capture, safe to close"

## Edge cases

- **No markers detected** — print "no scribe-worthy content this session" and exit
- **Multi-scope scribe finds nothing substantive after its own re-triage** — agent returns `{items_extracted: 0}` for all buckets. Report "scribe found no substantive items" and confirm safe to close.
- **Privacy blocklist hits** — the multi-scope scribe enforces its own privacy check (structural patterns + user-specific patterns loaded from `~/.claude/private-blocklist.json`). Don't duplicate the check here.

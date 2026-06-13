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

5. **Report what was captured** — print a summary listing files written, items appended, and confirm "safe to close session."

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
     - `git rev-parse --short HEAD` + the latest merged PR (from `git log --oneline -1`) → update the **Branch / HEAD** line.
     - `git log --oneline <last-verified-stamp>..HEAD` → fold any newly-merged work into the picture; do NOT paste the log (git history is authoritative) — only update what changed in the *current* state.
     - Scan open `PLAN-*.md` files for unchecked items → keep the **In-flight / outstanding** table accurate.
     - Update the **Last verified** stamp to today's date (from session context).
   - Keep it lean (< 100 lines). If a section has grown historical, move it to `archive/` rather than letting the file bloat — that bloat is exactly what this convention exists to prevent.
   - This is a curation pass, not a blind append. Only the model can do it well; that's why it lives here and not in a hook.

5. **Print summary:**
   - Items appended per scope (recommendations / cleanup / learnings)
   - Whether `SESSION_STATE.md` was refreshed (and what changed) or skipped (not present)
   - Files modified
   - Confirm **"Safe to close session."**

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

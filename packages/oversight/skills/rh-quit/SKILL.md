---
name: rh-quit
description: User-triggered scribe drain at session end. Reads the current session's transcript tail, dispatches the supervisor agent (scope=scribe) in-process via Task to curate recommendations, cleanup items, and learnings. Use when the user invokes /rh-quit, typically at the end of a session before closing.
---

# rh-quit

User-invoked scribe curation pass. The Stop hook's inline regex extraction (`rh-scribe-prefilter.js`) captures low-fidelity rows to `recommendations.md` and `cleanup.md` on every turn. This skill is the **high-quality LLM path**: it dispatches the supervisor + scribe agents in-process to curate, dedup, and write richer entries — especially learnings, which inline extraction skips entirely.

## What this skill does

1. **Read the transcript tail** — same 10K-char tail the prefilter uses, but fed to the supervisor for LLM-grade triage instead of regex.

2. **Detect scribe-worthy content** — apply the same marker regexes from `rh-scribe-prefilter.js` (recommendations, cleanup, learnings) to decide which sub-scopes to request.

3. **Dispatch supervisor in-process** — use the **Agent tool** (foreground, NOT background) with `subagent_type: rh-supervisor`. The supervisor fans out to `rh-scribe-recommendations`, `rh-scribe-cleanup-items`, and/or `rh-scribe-learnings` via Task as appropriate. This is synchronous — the user is waiting.

4. **Report what was captured** — print a summary listing files written, items appended, and confirm "safe to close session."

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

3. **If markers found, dispatch supervisor:**
   Use the Agent tool (foreground) with `subagent_type: rh-supervisor`. Prompt:
   ```
   You are being dispatched with scope=scribe (user-triggered via /rh-quit).
   Sub-scopes to evaluate: <detected scopes>.
   
   Read the transcript tail and dispatch the appropriate scribe agents:
   - rh-scribe-recommendations if substantive forward-action items present
   - rh-scribe-cleanup-items if substantive TODO/stale references present
   - rh-scribe-learnings if substantive conceptual deltas present
   
   This is a user-triggered end-of-session curation pass. The inline prefilter
   may have already captured low-fidelity rows for recommendations and cleanup.
   Your job is to curate — dedup against existing rows, improve quality, and
   capture learnings which the inline path skips entirely.
   
   Session ID: <session_id>
   ```

4. **Print summary:**
   - Scribe agents invoked: list
   - Files modified: list (recommendations.md, cleanup.md, learnings/*.md)
   - Confirm **"Safe to close session."**

## What was removed (do not recreate)

The prior architecture used an async queue + detached drain:
- `~/.claude/scripts/rh-scribe-drain.js` — **deleted**
- `~/.claude/scripts/rh-scribe-drain-startup.js` — **deleted**
- `~/.claude/rh-scribe-queue/` directory — **deleted**
- SessionStart drain-startup hook entry — **removed from settings.json**

These had multiple Windows failure modes (OneDrive cwd ENOENT, detached spawn ENOENT, child claude STATUS_CONTROL_C_EXIT). The replacement is inline regex extraction in the Stop hook + this in-process LLM curation skill.

## When to use

- User explicitly invokes `/rh-quit` at the end of a session
- This is the manual finishing move before closing Claude Code

## When NOT to use

- Mid-session — the Stop hook's inline prefilter handles per-turn capture automatically
- If the transcript has no markers — just confirm "nothing to capture, safe to close"

## Edge cases

- **No markers detected** — print "no scribe-worthy content this session" and exit
- **Supervisor finds nothing substantive** — the supervisor may decline to dispatch any scribes if the markers were false positives (e.g., "should" in a code comment). That's fine — report "supervisor found no substantive items" and confirm safe to close.
- **Privacy blocklist hits** — the supervisor and scribe agents enforce their own privacy checks (Personal/, Financial/, CS2025, Troy2023, Divorce). Don't duplicate the check here.

# Phase 0.1 — Why did stats-cache.json stop updating?

> Research output from subagent dispatch, 2026-05-20. Source registry at bottom.

## Verified facts

| Claim | Evidence | Verification token |
|---|---|---|
| `~/.claude/stats-cache.json` mtime 2026-04-07 18:04:38, 9629 bytes, version 3 | `stat` + Read | File last line (verbatim): `}` (line 464); line 463: `  "totalSpeculationTimeSavedMs": 0` |
| Cache schema version expected by binary = **3** | `grep -a` on `C:/Users/rossb/.local/share/claude/versions/2.1.145` finds `aEH=3` constant; cache file has `"version": 3` (line 2) | Match — no schema-mismatch migration would be triggered |
| Claude Code is installed as a **native binary** at `C:/Users/rossb/.local/bin/claude.exe` (227–229 MB PE32+), not npm/Node | `which claude`, `file`, `ls -la C:/Users/rossb/.local/share/claude/versions/` shows 2.1.139, 2.1.143, 2.1.145 | Install dates: 2.1.139 = May 11; 2.1.143 = May 17; 2.1.145 = May 19 |
| Binary still contains all stats-cache logic — load, stale-check, incremental update, migrate, save | `grep -a` finds: `"stats-cache.json"`, `"Stats cache empty, processing all historical data"`, `"Stats cache stale (${_.lastComputedDate}), processing ${z} to ${f}"`, `"Stats cache saved successfully (lastComputedDate: ${H.lastComputedDate})"`, `"Failed to save stats cache: ${ZH($)}"` | Code path still ships in current version |
| `~/.claude/settings.json` contains NO flag disabling stats; no `DISABLE_TELEMETRY` / `DISABLE_NONESSENTIAL_TRAFFIC` env vars in current shell | Full read of 239-line file (last-line token: `}`); `env \| grep` returns only `CLAUDECODE`, `CLAUDE_CONTEXT_WINDOW_SIZE`, `CLAUDE_TELEMETRY_URL`, etc. | Clean — no kill-switch active |
| `~/.claude.json` `installMethod: "native"` (line 3), `numStartups: 227` (line 2); `autoUpdates: false` (line 4) | Partial read (lines 1–100 of larger file) | Sufficient for top-level confirmation |
| **CHANGELOG: v2.1.118 merged `/cost` and `/stats` into `/usage`** | `~/.claude/cache/changelog.md` line 648 under `## 2.1.118` (line 645): *"Merged `/cost` and `/stats` into `/usage` — both remain as typing shortcuts that open the relevant tab"* | Quoted verbatim |
| CHANGELOG mentions historical-data loss on format change | Line 1207: *"Fixed `/stats` undercounting tokens by excluding subagent usage, and losing historical data beyond 30 days when the stats cache format changes"* | Quoted verbatim |
| **/stats and /usage in `-p` mode do NOT write the cache** | Before: mtime `2026-04-07 18:04:38.710536200`; ran `echo "/stats" \| claude --print` then `echo "/usage" \| claude --print`; After (both): mtime unchanged | Verified twice |
| A normal interactive `-p` session does NOT touch stats-cache | Ran `claude --print "hi"` with `--debug-file` writing 63,305 bytes of trace; `grep -i stats` returns 0 stats-cache-related events | Loader appears to fire only when the /usage TUI panel mounts |
| `~/.claude/projects/` is alive: 59 dirs, transcripts being written today | `ls` | Source data the cache *would* read is fresh and complete |
| Binary has no OneDrive-aware code path | `grep -a` finds only generic `EBUSY` once | OneDrive contention *possible* but not specifically handled |

## ✅ Outer-seam test — second run CONFIRMED (2026-05-20 14:23)

After the inconclusive first attempt, user re-ran `/usage` twice (one showed "Stats dialog dismissed" — the actual panel; one showed "Settings dialog dismissed"). Subsequent stat:

- mtime: `Apr 7 18:04` → **`2026-05-20 14:23:15`**
- size: 9,629 bytes → **18,821 bytes** (almost doubled)
- Birth = Modify (file was recreated, not just touched)
- Content refreshed: totalSessions `173` → **`306`**; totalMessages `34,301` → **`91,910`**; lastComputedDate `2026-04-07` → **`2026-05-19`**; dailyActivity 29 entries → **57 entries** (latest 2026-05-19)

**Verdict: original hypothesis CONFIRMED.** The writer fires when the `/usage` panel **fully mounts**. The first attempt's dismissed-dialog outcome was the panel never reaching mount (probably mid-mount dismiss). The second attempt's "Stats dialog dismissed" outcome was the actual /usage panel mounting fully, triggering the writer, then being dismissed by the user.

**What this means for v1:** opening `/usage` periodically refreshes the cache. v1 Overview will show fresh numbers (306 sessions) on next reload.

**What this means for v2:** Path A (rely on the cache) is *available* but still *not recommended*. The dependency on user-action-driven writes by an Anthropic-owned cache file makes Overview silently wrong any time the user doesn't open `/usage` for a while — which is exactly how we got here. Path B (live aggregation) remains the durable answer.

---

## ⚠️ First outer-seam attempt (2026-05-20 14:13 — INCONCLUSIVE; preserved for record)

**First test ran, hypothesis NOT YET DISCONFIRMED — but also not confirmed.** User opened an interactive `claude` session and ran `/usage`. Raw results:

- `~/.claude/stats-cache.json` **mtime unchanged**: still `Apr 7 18:04`.
- File **Access** time stamp is now `2026-05-20 14:13:25`.
- File size identical (9,629 bytes), content unchanged (`totalSessions: 173`, `lastComputedDate: 2026-04-07`).
- The session's `<local-command-stdout>` reported: **"Settings dialog dismissed"**.

**What is verified:** mtime did not advance; cache was not written during this test.

**What is NOT verified (and was wrongly asserted in an earlier revision of this doc):**
- That the `/usage` panel actually mounted and stayed mounted. The "Settings dialog dismissed" line is unexplained — it may indicate the user dismissed something rather than fully navigating the panel.
- That the Access-time advance was caused by the panel mounting. Anything in the Claude Code process that opens that file for read updates Access time; the cause is not directly attributable to the panel.
- That a single test with this much ambiguity is sufficient to disconfirm the writer-on-/usage-mount hypothesis.

**Status of original hypothesis:** weakened, not falsified. The test was inconclusive.

**Candidate causes (still all on the table, including the original hypothesis):**
1. Writer-on-/usage-mount (original) — possibly still true; test ambiguity prevents rejection.
2. **Stale-check predicate bug** — writer's `lastComputedDate` comparison may treat the file as "still fresh" despite being 43 days old (binary scan found strings but didn't decompile the predicate). Plausible given changelog hint about 30-day-format-change data loss.
3. **Writer requires a specific in-panel action** — opening the panel reads; writing may require user interaction inside the panel (refresh button, time-range change, tab switch). Would explain the dismissed-dialog observation.
4. **Writer was conditionally disabled in recent version** — binary still contains the strings, but the call path may be guarded by a flag that has flipped.
5. **Schema-version mismatch silent skip** — `version:3` matches the binary constant, but a sub-field shape might have changed.
6. **Permissions or lock contention silently failing** — `Failed to save stats cache` is a debug-log line; user wouldn't see it. (Less likely since file is writable per `ls -la`.)

**What would actually confirm or disconfirm:**
- User opens `/usage`, navigates within the panel (switches time range, clicks refresh, scrolls through sub-tabs), waits ~10s, checks mtime.
- Comparison test on a different machine where the cache *is* being written.
- Strace / Process Monitor on Windows to capture file-write syscalls during a `/usage` session.

**Recommendation:** do not make strategic v2 decisions on the test outcome alone. The Path A vs Path B choice in v2 should rest on independent reasoning (Anthropic owns the cache; depending on it creates a recurring failure mode), not on this single inconclusive test.

---

## Original root cause (best-evidence hypothesis — STATUS: weakened, not falsified)

**The cache file isn't being updated because the user hasn't opened the `/usage` (a.k.a. `/stats` / `/cost`) interactive panel since 2026-04-07.**

Concretely:
1. Claude Code's stats-cache writer is invoked **only when the `/usage` panel mounts in the TUI** — it does not fire on every session start, every Stop hook, or any background timer. A normal session's debug-file trace contains zero stats-cache events. Anthropic 2.1.118 made `/usage` the canonical entry; `/stats` and `/cost` still exist as shortcuts but open the same panel.
2. In headless `-p` mode the panel cannot mount, so `claude --print "/stats"` and `claude --print "/usage"` do not exercise the writer (proven: mtime unchanged across both invocations).
3. The cache schema is still version 3 and the binary's expected version is still 3, so this is **not** a format-mismatch / "returning empty cache" event. The file is healthy; it's simply orphaned because the panel hasn't been opened.
4. The user's last interactive `/usage`-panel session evidently occurred on 2026-04-07 18:04. The 6-week gap exactly tracks "I stopped opening that screen", not "the writer broke".

> **Verification gap (preserved verbatim from subagent):** "Could not exercise the actual `/usage` panel writer through its outer seam, because the seam is interactive-TUI-only and this agent has no PTY. Compensated by negative evidence (mtime unchanged across two `-p` attempts) and by changelog + binary string evidence."
>
> **Outer-seam confirmation requires:** user opens an interactive `claude` session and types `/usage`. If `~/.claude/stats-cache.json` mtime advances, hypothesis is confirmed. If it does not, the root cause is wrong and a new investigation is needed.

## Alternative hypotheses (ranked by remaining plausibility after evidence)

1. **OneDrive sync interfering with the write (LOW-MEDIUM).** `~/.claude/` is NOT under OneDrive on this machine (it's local `C:/Users/rossb/.claude/` AppData, not `OneDrive/Workspace/`), so the documented OneDrive EBUSY pattern doesn't apply. Binary contains no OneDrive-specific handling. Would need an additional `/usage`-open test that DOES fail to confirm.
2. **Silent save failure logged at debug level only (LOW).** Binary has `Failed to save stats cache: ${ZH($)}` at log level (not stderr). User wouldn't see it. But this only matters if `/usage` was being opened — and we have no evidence of that.
3. **Hook latency forcing the writer to skip (VERY LOW).** No flag or timeout-skip path found in binary string scan around the save call.
4. **Stale-check predicate bug treating today as not-stale (VERY LOW).** File is 6 weeks old; any reasonable predicate would flag it stale.
5. **DISABLE_TELEMETRY / DISABLE_NONESSENTIAL_TRAFFIC env flag (RULED OUT).** Neither set in current env nor in settings.

## Three resolutions ranked by effort

| Effort | Approach | Trade-off |
|---|---|---|
| **5 minutes** | User opens an interactive Claude Code session and types `/usage` once. Cache regenerates (likely up to ~30-day window per changelog hint about historical retention). | Trivial. Confirms hypothesis. Doesn't backfill the missing 6 weeks of pre-existing daily activity beyond whatever window the writer chooses. |
| **2 hours** | Write a recompute script that walks `~/.claude/projects/*.jsonl`, aggregates per-day messageCount / sessionCount / toolCallCount, and rewrites `stats-cache.json` in v3 schema. | Moderate. All source data exists (59 project dirs, 729 transcripts). Need to match the schema exactly: `dailyActivity[]`, `dailyModelTokens[]`, `modelUsage{}`, `totalSessions`, `totalMessages`, `longestSession`, `firstSessionDate`, `hourCounts{}`, `totalSpeculationTimeSavedMs`, `shotDistribution{}`. Risk: drifting from Anthropic's internal aggregation rules (e.g., subagent inclusion — see the 2.1.91 fix). |
| **Part of v2 work anyway** | Drop the `stats-cache.json` dependency in the dashboard; aggregate live from `~/.claude/projects/*.jsonl` + `oversight-events.jsonl` + `hook-perf.jsonl` on each dashboard load (or cache to our own file). | Higher up-front; lower long-term coupling. Eliminates the "third party silently stopped writing my datasource" failure mode permanently. Overview numbers become provably current. |

## Recommendation for the v2 plan

**Pursue option 3 (live aggregation in v2) and use option 1 as a temporary 5-minute unblock.**

Rationale:
- Anthropic owns `stats-cache.json`. They've already proven they can change its schema (the 2.1.118 `/usage` merge, the 30-day-data-loss bug). Continuing to depend on it makes the Overview tab silently wrong any time:
  - The user stops opening `/usage` (current failure)
  - Anthropic bumps the cache schema beyond v3 (next failure)
  - A migration path corrupts the file (`returning empty cache` branch)
- Since v2 is a rewrite anyway, factor the aggregation into our own pipeline. The raw materials are in `~/.claude/projects/*.jsonl` — that directory is alive (mtime today) and Anthropic uses it as the source of truth for `/usage` itself (binary `grep -a "claude/projects"`).
- Suggest a 24-hour TTL with a recompute-on-stale pattern, written by `packages/telemetry/server/` — not by Anthropic.
- **Meanwhile:** ask the user to open `/usage` once. If mtime advances, root cause confirmed and v1 Overview recovers temporarily. If it doesn't advance, new investigation needed before v2 commits to live aggregation as a *replacement* (could remain a supplement).

## Source registry

| File / source | Lines read | Verification token |
|---|---|---|
| `C:/Users/rossb/.claude/stats-cache.json` | Lines 1–50 + 455–464 of 464; rest verified via `wc -l` | Last line `}` (line 464) |
| `C:/Users/rossb/.claude/settings.json` | Full 239/239 | Last line `}` (line 238) |
| `C:/Users/rossb/.claude.json` | Partial 1–100 (large file) | Sufficient for installMethod/numStartups/autoUpdates |
| `C:/Users/rossb/.claude/cache/changelog.md` | Lines 640–689 + 1153–1182 + 1195–1219 + grep-scanned remainder | Quoted lines 648 + 1207 verbatim |
| `C:/Users/rossb/.local/share/claude/versions/2.1.145` (binary) | Scanned via `grep -a` for ~15 string patterns; not "read" in source-file sense | Matched strings recorded above |

**Subagent telemetry:** 0 compactions; ~31% of 1M Opus window used.

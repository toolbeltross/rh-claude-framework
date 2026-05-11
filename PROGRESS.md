# rh-claude-framework — Progress & Pickup Notes

**Last session:** 2026-05-09 (verification-token wording: first → last line)
**Repo:** `C:\Users\rossb\OneDrive\Workspace\toolbeltross\toolbeltross-public\rh-claude-framework\`
**Branch:** `main` — see latest commit for verification-token wording change

---

## 2026-05-09 session — what landed

**Verification-token wording change (Option A hard cutover):** rules now require the literal **last line** of a source file (proves read reached EOF) plus total line count and line range read. First-line tokens prove only that the file was opened — they don't catch silent Read-tool truncation at ~10K tokens, which is the failure mode the rule exists to mitigate.

15 files modified in `packages/oversight/`:
- 3 rules: `rh-subagent-oversight.md` (lines 11, 53; also added missing ScheduleWakeup section that had drifted to workspace-only), `rh-read-integrity.md` (line 21), `rh-completion-standards.md` (line 11)
- 5 scripts: `rh-agent-oversight-guard.js` (regex + inlined CANONICAL_BLOCK), `rh-agent-result-guard.js` (2 regexes), `rh-consolidation-guard.js` (regex + error msg), `rh-learning-loop.js` (instruction text + comment), `rh-oversight-self-test.js` (test fixture)
- 6 agents: `rh-source-verifier.md` (2), `rh-pdf-extractor.md`, `rh-scribe-multiscope.md` (2), `rh-scribe-cleanup-items.md`, `rh-scribe-learnings.md`, `rh-scribe-recommendations.md`
- 1 test: `tests/test-guards.js` (5 fixture updates)

Also synced `claude-setup-ross/oversight-system/OVERSIGHT_SYSTEM.md` (6 stale references at lines 123, 199, 288, 295, 347, 401, 409).

**Outer-seam verification:**
- `node packages/oversight/tests/run.js` → 45/45 passing
- `node ~/.claude/scripts/rh-oversight-self-test.js` → 37/37 hard passed
- Re-ran `rh-oversight init` to propagate canonical → installed copies after edits

---

## 2026-05-08 session — what landed

**9 commits pushed to `origin/main`** (oldest → newest):

| Commit | Item | Summary |
|---|---|---|
| `b7c969f` | P0-6 wrap | rh-auto-prune session-marker pruning (>30d cutoff) |
| `a54ac79` | P2-2 | cross-package contract test for Stop hook chain |
| `fc799e3` | follow-up to P2-2 | dedupe Layer 3a prompts across packages by signature |
| `dec50b5` | P1-4 step 1 | prompt directive "dispatch in parallel" (superseded) |
| `4fa3d74` | P1-4 step 2 | new `rh-scribe-multiscope` agent — single-pass scribe |
| `1391918` | P1-4 step 3 | scope=scribe fast-path block in rh-supervisor |
| `676c668` | P1-4 step 4 | /rh-quit dispatches rh-scribe-multiscope DIRECTLY (supervisor removed from path) |
| `8e7b6c6` | P1-6 + P1-7 | atomic sentinel-aware table writes (rh-scribe-table-write.js helper + prefilter strip-all-sentinels) |
| `533d61e` | privacy scrub | externalized user-specific privacy blocklist; framework no longer carries entity names |

**Plan checkboxes** (`claude-setup-ross/oversight-system/PLAN-2026-05-08-reliability-hardening.md`):
- Phase 0 (P0-1..P0-7) ✅
- Phase 1: P1-1, P1-2, P1-4, P1-5, P1-7 ✅; P1-6 `[~]` partial (helper-swap landed, latency outer-seam test pending); P1-3 `[~]` code landed 2026-05-10, awaiting production-flag flip + first /rh-quit consumption
- Phase 2: P2-1, P2-2, P2-3 ✅; P2-4 open
- Phase 3: P3-1, P3-2 open
- Phase 4 ✅
- Phase 5: P5-1 open (gated on Phase 1-3)

**Other work this session (separate from the numbered plan):**
- 22 stale `session-marker-*.json` bulk-deleted from `~/.claude/`
- 6 scribe rows marked resolved in `cleanup.md` + `recommendations.md` for items closed by recent commits
- 3 stale duplicate docs archived to `claude-setup-ross/Archive/` with closing notes (P4-2)
- 28 unprefixed rule references in OVERSIGHT_SYSTEM.md bulk-replaced (P4-1, all 35 occurrences across 13 distinct patterns)
- Privacy scrub: 7 heavy-reference docs moved from `claude-setup-ross/` → `Personal/Financial/Troy2023/archive/`; 9 light-reference docs edited in place; framework code 100% clean of user-specific entity names
- Global gitignore configured at `~/.config/git/ignore` with `Personal/`, `**/Personal/`, `Personal/**`, `**/.claude/private-blocklist.json`
- `~/.claude/private-blocklist.json` seeded with the 3 user-specific tokens (gitignored, runtime privacy fully restored — verified via 6/6 smoke-test)

---

## Pickup checklist for next session

### IMMEDIATE — drain this session's markers
This session contains substantive content across all 3 sub-scopes (recommendations, cleanup, learnings) that was NEVER drained because `rh-scribe-multiscope` is not in this session's subagent registry (loaded before commit `4fa3d74`). When you start the next session:

```
/rh-quit
```

The fresh session will have the multiscope agent loaded. It should: dispatch a single Task call to `rh-scribe-multiscope`, write to `recommendations.md` / `cleanup.md` / `~/.claude/memory-shared/learnings/<topic>.md`, and confirm "safe to close session." Wall-clock should be measurably faster than the 286s observed in the 2026-05-08 test #3 (target <90s).

### Outer-seam test prompts pending verification

**P1-6 latency drop** — after running `/rh-quit` above, confirm:
- `bashCount` in multiscope's toolStats: should drop from 25 (test #3, pre-helper-swap) to ~3-5 (one helper call per file)
- Wall-clock < 90s
- Multiscope invokes `rh-scribe-table-write.js` and/or `rh-learnings-write.js` per its bash trace (NOT bare `>>` redirects or `grep -v` cleanup)

If those signals confirm, mark P1-6 ✅ in plan.

### Soft follow-up (low urgency)

**Doc-sync probe path-resolution** — `rh-oversight-self-test.js` `runDocSyncProbe()` (line 277) reads `OVERSIGHT_SYSTEM.md` from `config.oversightDir`, which defaults to `~/.claude/oversight/`. Ross's hand-authored design doc actually lives at `claude-setup-ross/oversight-system/OVERSIGHT_SYSTEM.md`. `~/.claude/oversight.json` doesn't override the path, so the probe always reports "OVERSIGHT_SYSTEM.md not found — skipped." Result: the soft sync warning never fires for Ross's environment, even when the design doc is genuinely stale. Fix is one of: (a) add `oversightDir` override to `~/.claude/oversight.json` pointing at `claude-setup-ross/oversight-system/` (user-config only, no framework change), or (b) make the probe also look in a `<workspace>/claude-setup-ross/oversight-system/` fallback. (a) is simpler and stays out of framework code.

### Open queue (priority order)
1. ~~**P1-3** Replace 10K-char tail with per-turn staging file + /rh-quit true-up~~ — **code landed 2026-05-10, default-off.** New `lib/scribe-staging.js` (offset-delta JSONL per session, 7-day TTL), prefilter wired additively behind env `RH_SCRIBE_STAGING=1` / `oversight.json: scribeStaging:true`, CLI reader `rh-scribe-staging-read.js`, `/rh-quit` SKILL updated, auto-prune sweeps stale staging. 12 new unit tests + outer-seam helper at `packages/oversight/tests/helpers/p1-3-outer-seam.js` (18/18). Suite: 57/57 passing. **Before flipping flag to ON:** verify multiscope agent uses the reader CLI per updated SKILL.md, then set env var in `~/.claude/settings.json` or `scribeStaging:true` in `~/.claude/oversight.json`
2. **P2-4** settings.json safety rails — needs design call: git-track in private repo? validation pre-write hook? merge-aware `rh-oversight-settings` CLI? Different implications.
3. **P3-1** Cross-session supervisor sweep — weekly trend doc; depends on accumulated P2-1 orphan + P2-3 InstructionsLoaded events
4. **P3-2** Dashboard "Trends" tab — frontend work in `packages/telemetry/src/`
5. **P5-1** Anthropic deliverable — `docs/PATTERNS.md` + framework README pitch + 2-page summary; gated on Phase 1-3 stability

### Useful commands

```bash
cd C:/Users/rossb/OneDrive/Workspace/toolbeltross/toolbeltross-public/rh-claude-framework

# tests
node packages/oversight/tests/run.js              # 45/45 expected

# health snapshot
node packages/oversight/scripts/rh-oversight-health.js

# verify tree clean (it is, as of session-end)
git status
git log origin/main..HEAD --oneline               # should be empty

# verify privacy is clean (no user-specific names in framework)
grep -rc "Troy2023\|CS2025" packages/ | grep -v ":0" | head    # should be empty

# verify global gitignore working
git check-ignore -v Personal/file.md              # from any repo dir
```

### Known leftover state
- `~/.claude/scribe-pending-*.flag` — 3 flags exist (<24h old at session-end); auto-prune will sweep them after their 24h cutoff
- `Workspace/.claude/settings.local.json` — earlier in session removed one Bash() permission entry that referenced the private path; if you need that permission back, add it without the literal entity name in the path
- This session's transcript JSONL still contains conversational mentions of the entity names (in messages I wrote when discussing the scrub itself); the file is at `~/.claude/projects/...57f01915.jsonl` and isn't gitignored, but the directory `~/.claude/` is per-user so it's not at risk of being committed

## What exists

| Component | Location | Status | Tested |
|---|---|---|---|
| Root package.json (npm workspaces) | `package.json` | Done | n/a |
| Config module | `packages/oversight/scripts/lib/config.js` | Done | 6 unit tests passing |
| Shared libs (oversight-events, hook-timing, hook-perf-audit) | `packages/oversight/scripts/lib/` | Done | Syntax-checked |
| 16 enforcement scripts | `packages/oversight/scripts/rh-*.js` | Done — all refactored from `~/.claude/scripts/` | 10 guard tests passing + all 16 syntax-checked |
| 18 agent definitions | `packages/oversight/agents/rh-*.md` | Done — all hardcoded paths replaced | Grep-verified clean |
| 2 skill definitions (session, quit) | `packages/oversight/skills/rh-*/` | Done — paths parameterized | session-inventory.js syntax-checked |
| 12 workspace rules | `packages/oversight/rules/` | Done — security split into base + local template | Grep-verified: zero user-specific paths |
| Templates (CLAUDE.md, settings.json) | `packages/oversight/templates/` | Done | settings.json template used by init dry-run |
| Init CLI (`rh-oversight init/reset/self-test`) | `packages/oversight/bin/rh-oversight.js` + `lib/init.js` | Done | **Dry-run only** — write path NOT tested |
| Test suite | `packages/oversight/tests/` | Done — 16/16 passing | Runner + config + guard suites |
| packages/telemetry/ | Migrated 2026-05-04 (chore/migrate-telemetry-to-monorepo, `f91cc47`) | Done — full project copy | Tests pass; install-skills.js hardened 2026-05-06 (DECISIONS.md entry) |

## Zero hardcoded paths verified

```bash
grep -r "rossb\|C:/Users/rossb\|OneDrive/Workspace\|claude-setup-ross\|toolbeltross" \
  --include="*.js" --include="*.md" --include="*.json" packages/
# Result: CLEAN — no matches
```

## What is NOT done

### Must-do before first real install

1. ✅ **Test `rh-oversight init` without `--dry-run`** — Verified 2026-05-04 against tmp HOME `C:/Users/rossb/AppData/Local/Temp/rh-test-home-xRVm/`. `oversight.json` written with workspace + oversightDir + telemetryPort=7890; settings.json merged 4 phases / 8 hook entries; 20 scripts + 18 agents + 3 skills + 12 rules copied; starter CLAUDE.md written to tmp workspace.
2. ✅ **Test installed scripts from `~/.claude/scripts/`** — Verified 2026-05-04. Self-test from installed location `<TMP_HOME>/.claude/scripts/rh-oversight-self-test.js` returned `oversight-self-test: 37/37 hard passed`. Relative `./lib/config` requires resolve correctly post-copy.

### Should-do before sharing

5. ✅ **Migrate telemetry project** into `packages/telemetry/` — landed via `chore/migrate-telemetry-to-monorepo` (`f91cc47`, 2026-05-04). The standalone `toolbeltross/rh-telemetry` GitHub repo is now archived (read-only); the monorepo `packages/telemetry/` is canonical. See [`PLAN-20260504-framework-followups.md`](PLAN-20260504-framework-followups.md) Phase D for the original plan. Note: `setup-hooks.js` may still have hardcoded paths to audit (supervisory prompt rule citations) — separate followup.
6. ✅ **Initial git commit** — done in a prior session (commit `9c3455f`). This session added 2 more commits (rename `85c82ab`, merge `8745c69`).
7. ✅ **CLAUDE.md for the framework repo itself** — [`CLAUDE.md`](CLAUDE.md) authored 2026-05-04
8. ✅ **README.md** with install instructions — [`README.md`](README.md) authored 2026-05-04

### Nice-to-have

9. Integration test: spawn `rh-oversight init` against a tmp HOME, then run self-test from the installed location *(Phase A of PLAN-20260504-framework-followups.md performed this manually; codifying it as a repeatable test is still pending)*
10. ❌ npm link / npm pack testing for global install path — closed 2026-05-06; npm publication is not being pursued (see `packages/telemetry/PLAN-distribution-readiness.md` status header)

### Known issues

11. ✅ **RESOLVED 2026-05-06 (PR #18)** — `rh-oversight init` overwrites Stop hooks added by `rh-telemetry setup`. Original problem: on 2026-05-04, running `rh-oversight init` after `rh-telemetry setup` clobbered `hook-forwarder.js stop` from the Stop chain in `~/.claude/settings.json`. The supervisory log silently went 3 days without entries. Root cause: `lib/init.js`'s merge logic keyed by full entry (matcher + ALL commands concatenated), so different command lists produced different keys → template entry got appended as a new entry (or replaced existing if cold-start), losing foreign hooks. **Fix landed PR #18:** extracted pure `mergeHooksData` function with per-hook additive merge — same-matcher entries now merge per-hook, deduping by command/prompt content; foreign hooks are preserved. 7 new unit tests including the F-10 regression scenario (`tests/test-init-merge.js`); oversight test suite 26/26 passing. Detection-layer redundancy from PRs #16/#17 (staleness probes) retained — they catch the failure class generically; PR #18 fixes the specific mechanism at the root.

## Key architecture decisions (for pickup context)

- **One repo, two packages** — `packages/oversight` (enforcement) + `packages/telemetry` (dashboard). User decided.
- **CJS throughout** — all scripts use `require()`. Matches existing installed scripts.
- **Config priority:** env var > `~/.claude/oversight.json` > auto-detect (walk up from CWD looking for `.claude/rules/`)
- **Security rule split:** `rh-security.md` (framework base) + `rh-security-local.md.template` (user's private dirs, gitignored). User decided.
- **Generators use configurable oversightDir** — defaults to `~/.claude/oversight/`. Ross's config points to `claude-setup-ross/oversight-system/`.
- **Init acquires user-specific values** via CLI args (`--workspace`, `--oversight-dir`, `--private-dirs`) and writes `~/.claude/oversight.json`.

## How to pick up

```bash
cd C:/Users/rossb/OneDrive/Workspace/toolbeltross/toolbeltross-public/rh-claude-framework

# Run tests
node packages/oversight/tests/run.js

# Dry-run install
node packages/oversight/bin/rh-oversight.js init --dry-run

# Check for stale hardcoded paths
grep -r "rossb\|C:/Users/rossb" --include="*.js" --include="*.md" packages/
```

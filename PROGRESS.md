# rh-claude-framework — Progress & Pickup Notes

**Last session:** 2026-05-16 (P1-3 flag flip ✅ + npm test workspace gap ✅, PRs #46–#47)
**Repo:** `C:\Users\rossb\OneDrive\Workspace\toolbeltross\toolbeltross-public\rh-claude-framework\`
**Branch:** `main` — at merge of PR #47 (`4474103`)

---

## 2026-05-16 session — cleanup: P1-3 flag flip + npm test workspace gap

**1 PR merged to main:**

| PR | Title | Merge commit |
|---|---|---|
| #47 | fix: add no-op test script to @rh/shared and @rh/skills | `4474103` |

**P1-3 flag flip (no PR — config change only):**
- Verified `packages/skills/rh-quit/SKILL.md` already references `rh-scribe-staging-read.js` (prerequisite met)
- Set `scribeStaging: true` in `~/.claude/oversight.json`
- Outer-seam verified: `rh-scribe-staging-read.js <session-id> --stats` → `enabled: true`, 4 turns staged, 0 truncated

**npm test workspace gap:**
- Added `"test": "echo 'No tests for this package' && exit 0"` to `packages/shared/package.json` and `packages/skills/package.json`
- `npm test` across all workspaces: 0 failures, all real suites pass (oversight 177, cli 54, output 1, telemetry 28/28)

**Open queue:** None.

---

## 2026-05-12 session — Phase 4b + path-typo guard + failure-store isolation + test-coverage grind

**10 PRs merged to main** in this session (#25–#34):

| PR | Title | Merge commit | Tests added |
|---|---|---|---:|
| #25 | refactor(framework): per-package install.json manifest decomposition (Phase 4b) | `863801f` | +9 (manifest engine) |
| #26 | feat(oversight): path-typo guard for Read calls (.claire/.clone → .claude) | `a5ce280` | — |
| #27 | fix(telemetry): isolate FailureStore from real failure log in test runs | `22a1baf` | — |
| #28 | test: cover rh-path-typo-guard + failure-store alreadyIsolated guard | `85019c8` | +16 |
| #29 | test+cleanup: cover rh-scribe-staging-read + remove rh-statusline-wrapped | `9d5c989` | +8 |
| #30 | chore: scrub `rossb` username from telemetry docs + test fixtures | `e08836a` | — |
| #31 | test(oversight): cover rh-supervisor-preload.js (9 tests) | `316c4f5` | +9 |
| #32 | test(output): cover rh-render-md-html.js (18 tests) | `22885c4` | +18 |
| #33 | test(oversight): cover rh-learning-loop.js exported functions (22 tests) | `303f820` | +22 |
| #34 | fix+test(output): fail-soft on missing OVERSIGHT_SYSTEM.md + 11 tests for rh-generate-state-md | `fffc1ff` | +11 |
| #35 | docs(progress): log session through PR #34 | `4d32f33` | — |
| #36 | test(oversight): cover rh-oversight-health.js | `876cb35` | +11 |
| #37 | test(output): cover rh-scribe-table-write.js | `ebc12a9` | +14 |
| #38 | test+fix: cover rh-learnings-write + manifest excludeSubdirs + 4 missing source-tree lib shims | `e6383e8` | +21 |
| #39 | docs(progress): log PRs #35-#38 | `5b5e3d2` | — |
| #40 | test+fix(output): cover rh-auto-prune + fix inconsistent return shape | `9f043a1` | +15 |
| #41 | test(output): cover rh-daily-regen-trigger | `946989c` | +7 |
| #43 | test: cover 5 remaining untested scripts (+67 tests) | `eb44c87` | +67 |

**Cumulative test count delta this session: +228 tests** across 4 packages.

**Test counts now (per `node packages/<pkg>/tests/run.js`):**
- oversight: 177 (was 45 baseline; +132 across session)
- cli:       54 (was 43; +11)
- output:    112 (was 1 baseline; +111 across session)
- telemetry: 28/28 files pass (multiple tests per file)

**Cleanup ops in this session:**
- Stale remote branch `origin/chore/add-reconciliation-plan` deleted (was `0 ahead, 67 behind`; tip already in main)
- 7 local detached branches deleted (`rh/cli-phase4`, `rh/docs-phase5`, `rh/skills-phase3`, `rh/test-coverage-recent-work`, `rh/cli-manifest-phase4b`, `rh/heuristic-mendel-0caba7`, `rh/cleanup-and-staging-read-tests`)
- Dormant worktree `inspiring-cartwright-e3da7c` removed
- `rh-statusline-wrapped.js` (dead + hardcoded `rossb`) removed (PR #29)
- `rossb` username scrubbed from 8 telemetry doc + test files (PR #30) — framework code is now `rossb`-free per `grep -r rossb --include="*.js" --include="*.json" packages/`

**Production bugs found + fixed:**
- PR #34: `rh-generate-state-md.js` crashed unconditionally when OVERSIGHT_SYSTEM.md was absent, despite `sectionHeader()` already having a `NOT FOUND` branch. Now fail-soft. Daily-regen in tmp HOME went **7/10 → 9/10**.
- PR #27: FailureStore default-path guard introduced `alreadyIsolated` exception — when FAILURE_LOG_PATH is already inside tmpdir (integration tests' HOME=tmpdir pattern), don't override it. Without this guard, 3 integration tests broke when NODE_ENV=test was forced.
- PR #38: Source-tree dependency coherence bug from Phase 2 reorg — `packages/output/scripts/lib/` was missing shims for `phase-timing`, `journal-probe`, `oversight-events`, `scribe-staging`. Post-install worked (oversight's full lib copy provided canonicals), but source-tree dev/test execution broke. Fix: added 4 shims + new manifest `excludeSubdirs` option so output's lib stays source-tree-only. Byte-identical install verified.
- PR #40: `pruneScribeFile` returned inconsistent shape when the source file was absent (`{archived, staleOpen, file: <full-path>}` vs `{archived_count, stale_open_count, file: <basename>}` for present files). Fix: missing-file branch returns the canonical shape so callers iterating `scribe_files` don't see undefined counts.

**Plan for next session:**
- ~~Test coverage grind complete~~ — all scripts now have tests (PR #43)
- **P5-1** Anthropic deliverable: `docs/PATTERNS.md` + framework README pitch + 2-page summary (gate "Phase 1-3 stability" now passed)
- **P1-3 flag flip**: flip `scribeStaging: true` in `~/.claude/oversight.json`, verify multiscope uses the reader CLI, confirm `/rh-quit` wall-clock < 90s
- Remaining hardcoded-identity references in `packages/telemetry/docs/*.md`: `claude-setup-ross`, `OneDrive/Workspace`. Smaller surface; defer until clear value.

---

## 2026-05-11 session — 5-package reorg + telemetry UI fixes

**6 PRs merged to main** in this session:

| PR | Title | Merge commit |
|---|---|---|
| #20 | telemetry: dashboard visual audit fixes + STYLEGUIDE.md | `6a614f5` |
| #21 | framework: 5-package reorg Phases 1+2 (shared/ + output/) | `fe0b15f` |
| #22 | framework: extract packages/skills/ (Phase 3) | `76e17a5` |
| #23 | framework: extract packages/cli/ meta-installer (Phase 4) | `25bdbd4` |

**Reorg layout** — all 6 packages now peers under `packages/`:

- `shared/` — canonical config + cross-process file-lock + env helpers
- `oversight/` — enforcement scripts/agents/rules only (no install logic, no skills, no output writers)
- `output/` — HTML renderers + scribe writers + daily-regen orchestrator + 3 hardened withLock-wrapped writers
- `skills/` — `/rh-quit` + `/rh-session`
- `cli/` — `rh-oversight` bin + init.js + settings-cli.js + templates + cross-package contract test
- `telemetry/` — unchanged

**Concurrency hardening** (Phase 2):
- `rh-generate-state-md.js`, `rh-render-md-html.js`, `rh-daily-regen.js markRanToday()` wrapped in `withLock`
- New 16-way bash-parallel concurrent-write stress test in `packages/output/tests/`
- Documented exception: `rh-daily-regen.js` LOG_PATH append stays unlocked (JSONL atomic-append assumption + same-day guard)

**Test counts** post-reorg:
- oversight: 76 (down from 119; 43 moved to cli)
- cli: 43 (init-merge + cross-package-contract + settings-cli)
- output: 1 (concurrent stress)
- **total: 120 — matches pre-reorg + 1 new concurrency test**

**Outer-seam verification** done in-session:
- Tmp-HOME install via `node packages/cli/bin/rh-oversight.js init`: 25 oversight + 10 output + 3 shared + 19 agent + 3 skill + 12 rule files
- Self-test from installed location: 37/37 hard pass
- `diff -rq` of installed `~/.claude/` between cli-install and main-install at each phase: byte-identical (modulo expected tmp-path noise in oversight.json/settings.json)

**Deferred to follow-up PR**: Phase 4b — per-package `install.json` manifest decomposition. The cli installer still aggregates a monolithic settings.json.template and hardcodes which packages it reads from. A manifest would let each sibling declare its own install fragment.

**Plan reference**: `plans/do-some-analysis-on-iridescent-clock.md`.

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
- Phase 2: P2-1, P2-2, P2-3, P2-4 ✅ (P2-4 landed 2026-05-10 — both (a) pre-write validator gate and (c) merge-aware CLI)
- Phase 3: P3-1 ✅, P3-2 ✅ (both landed 2026-05-10)
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
2. ~~**P2-4** settings.json safety rails~~ — **landed 2026-05-10**. Both (a) pre-write validator gate and (c) merge-aware CLI; (b) git-tracking was not pursued (caller can use the `backup`/`restore` subcommands instead, or wrap them with their own VCS). New `packages/oversight/scripts/lib/settings-validator.js` (pure function returning structured `{ok, errors, warnings}` with stable codes like `hooks.item.command.missing`). Validator is wired into `lib/init.js` as a pre-write gate on the FULLY MERGED object — errors abort without writing, warnings surface but allow. New `lib/settings-cli.js` exposes `rh-oversight settings <validate|show|diff|merge|backup|restore>` with dry-run-by-default for `merge` (requires `--apply` to write), validation gate on `merge`/`restore`, automatic timestamped backup on `merge --apply`. 26 unit tests in `test-settings-validator.js` + 17 CLI integration tests in `test-settings-cli.js`; outer-seam helper at `packages/oversight/tests/helpers/p2-4-outer-seam.js` invokes real `rh-oversight settings ...` + `rh-oversight init` subprocesses (20/20 assertions including the init-refuses-to-write-bad-settings F-10-prevention check). Suite: 100/100.
3. ~~**P3-1** Cross-session supervisor sweep~~ — **landed 2026-05-10**. New `packages/oversight/scripts/rh-supervisor-sweep.js` reads `~/.claude/oversight-events.jsonl` + supervisory-log Layer3a rejections over a sliding window (default 7d), aggregates by event_type / day / session / missing-elements / subagent-patterns, and writes a structured trend doc to `~/.claude/memory-shared/supervisor-trends.md` with summary table, prior-window delta column, daily-cadence ASCII bar chart, top-N sessions, and source-verification block. Wired as `rh-oversight supervisor-sweep` subcommand. CLI flags: `--days N`, `--out <path>`, `--json`, `--dry-run`. 19 new unit tests in `test-supervisor-sweep.js` (parseArgs, readEvents, readLayer3aRejections, aggregate, renderMarkdown, formatDelta, plus the plan-required 7-day synthetic-events end-to-end). Outer-seam helper `p3-1-outer-seam.js` (22/22) runs the real subprocess against synthetic events AND against the user's actual 757-event `oversight-events.jsonl` (635 events in last 7d resolved correctly). Suite: 119/119.
4. ~~**P3-2** Dashboard "Trends" tab~~ — **landed 2026-05-10**. Backend: new `packages/telemetry/server/trends-router.js` exposes `GET /api/trends?days=N` (capped at 90, defaults 7) wrapping the sweep aggregation via createRequire cross-package import. Default sources are HOME-derived, query-string overridable for tests. Frontend: new `packages/telemetry/src/components/TrendsTab.jsx` (React + Recharts) with day-range selector (1/7/14/30), 3 summary cards with prior-window deltas, daily-cadence BarChart, event-type table with deltas, top missing oversight elements + subagent-failure patterns, top sessions by event count. Wired into App.jsx tab system (added 'trends' to the activeTab whitelist on line 297 — without it, activeTab='trends' was reset to overview by the unknown-tab guard). 6 integration tests in `tests/integration/trends-router.test.js` (spawned-server harness against synthetic events). Browser verification via Playwright dev-server check confirmed live render against the user's real 636-event log (instructions_loaded +476, oversight_auto_inject -18, all 6 event types surfaced with correct prior-window deltas, daily-cadence SVG renders).
5. **P5-1** Anthropic deliverable — `docs/PATTERNS.md` + framework README pitch + 2-page summary; **gate cleared** (all scripts now tested, framework stable)

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

_Updated 2026-05-11 to reflect 5-package reorg (PRs #21–23)._

| Component | Location | Status |
|---|---|---|
| Root package.json (6 npm workspaces) | `package.json` | Done |
| Canonical config + file-lock + env helpers | `packages/shared/` | Done — config has `scribeStaging` flag (P1-3) |
| Source-tree shims (config, file-lock) | `packages/oversight/scripts/lib/` | Done — installer overwrites with shared canonical |
| 25 enforcement scripts (incl. supervisor-sweep, scribe-staging-read, settings-validator) | `packages/oversight/scripts/` | Done |
| 19 agent definitions | `packages/oversight/agents/` | Done |
| 2 skill definitions (rh-quit, rh-session) | `packages/skills/` | Done — moved Phase 3 |
| 12 workspace rules | `packages/oversight/rules/` | Done |
| 8 output writers (HTML render, scribe table, learnings, daily-regen, etc.) | `packages/output/scripts/` | Done — 3 unlocked writers wrapped in withLock |
| Init CLI + bin + templates + cross-package contract test | `packages/cli/` | Done — Phase 4 |
| Test suite | 76 oversight + 43 cli + 1 output = 120 passing | Done |
| `packages/telemetry/` | Migrated 2026-05-04 (`f91cc47`) | Working; UI fixes + STYLEGUIDE.md merged 2026-05-11 (PR #20) |

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

# Run tests (76 + 43 + 1 = 120 expected)
node packages/oversight/tests/run.js
node packages/cli/tests/run.js
node packages/output/tests/run.js

# Dry-run install (cli is the new home for the bin)
node packages/cli/bin/rh-oversight.js init --dry-run

# Check for stale hardcoded paths
grep -r "rossb\|C:/Users/rossb" --include="*.js" --include="*.md" packages/
```

# PLAN — Oversight reconciliation: deployed ↔ framework

**Created:** 2026-05-04 (queued from cutover session)
**Status:** ✅ EXECUTED 2026-05-04 (same day) — framework reconciled with deployed via PR #5; init idempotency bug surfaced during deploy fixed via PR #6.
**Original deferral reason:** medium-risk per-file work; needed deliberate plan + fresh context budget — proceeded same-session after user pushed forward.

## Resolution summary

- **PR #5** (`chore/oversight-reconcile-with-deployed`, merged): bulk-copied deployed → framework as zero-loss base, mechanically reapplied `lib/config` abstraction via regex transform, plus targeted fixes for `claude-setup-ross/...` paths to use `config.oversightDir` family. 19 oversight scripts in framework (12 use `lib/config` — others have no path resolution to abstract). 2 missing lib helpers added (`file-lock.js`, `phase-timing.js`).
- **PR #6** (`fix/oversight-init-idempotency`, merged): init template was overwriting user-customized env vars + duplicating matchless hooks; fixed.
- **Live deploy:** `rh-oversight init` against Ross's HOME wrote merged scripts to `~/.claude/scripts/`; backup at `~/.claude/scripts.pre-reconcile-20260504-151528/`.
- **Outer-seam verification:** self-test from live `~/.claude/scripts/` returned **37/37 hard passed**, doc-sync probe now PASSES, hook-debug.log shows fresh entries from this session.
- **Settings.json post-deploy fixes:** init's aggressive merge clobbered `OVERSIGHT_LOG_PATH` and created duplicate SessionStart hooks; both fixed by hand. The fix in PR #6 prevents this on future re-runs.

The phase checkboxes below were the original plan; **all are now done** (verified outer-seam). Kept here as historical narrative.

---

## The drift

| | Deployed `~/.claude/scripts/*.js` | Framework `packages/oversight/scripts/*.js` (commit `9c3455f`, 2026-05-02) |
|---|---|---|
| Architecture | Hardcoded `path.join(HOME, ".claude", "scripts")`, inline env-var resolution | `require('./lib/config')` + `config.scriptsDir`, `config.telemetryPort`, etc. |
| Edits since 2026-05-02 | Yes — Ross + sessions edited 8+ files (mtimes 2026-05-03 / 04) | None |
| `lib/config` adoption | **0 of 19** | **13 of 16** |
| Comments / docstrings | Verbose JSDoc with safety notes (e.g., "CRITICAL size bound", "JSONL atomic-append assumption") | Terser one-liners |
| Files unique to one side | 3 deployed-only (`rh-learning-loop.js`, `rh-learnings-write.js`, `rh-supervisor-preload.js`) | None |

**How it happened:** the 2026-05-02 framework session created a parameterized refactor of deployed scripts into `packages/oversight/`, marked the work "Done" in PROGRESS.md, but never deployed (item #1 was the gate). Edits to deployed continued; framework was never re-synced.

**How this session missed it:** Phase A of the migration plan tested `rh-oversight init` mechanically (against tmp HOME) but didn't diff the framework's resulting copies against Ross's existing `~/.claude/scripts/`. Took PROGRESS.md "Done" at face value.

---

## Goal

Single source of truth at `packages/oversight/scripts/*.js`:
- All deployed work preserved (zero loss)
- `lib/config` abstraction reapplied (so `rh-oversight init` produces a portable install for other users)
- Defaults aligned between framework's `lib/config.js` and what deployed currently expects

---

## Triage (already done — drift line counts in current `~/.claude/scripts/` vs framework `9c3455f`)

| File | Functional diff lines |
|---|---:|
| `rh-render-md-html.js` | 0 |
| `rh-statusline.js` | 0 |
| `rh-daily-regen-trigger.js` | 9 |
| `rh-layer3a-capture.js` | 12 |
| `rh-consolidation-guard.js` | 14 |
| `rh-agents-loaded-marker.js` | 18 |
| `rh-agent-oversight-guard.js` | 37 |
| `rh-agent-result-guard.js` | 57 |
| `rh-scribe-prefilter.js` | 112 |
| `rh-statusline-wrapped.js` | 116 |
| `rh-read-audit.js` | 138 |
| `rh-daily-regen.js` | 175 |
| `rh-oversight-self-test.js` | 192 |
| `rh-check-anthropic-guidance.js` | 268 |
| `rh-generate-state-md.js` | 834 |
| `rh-generate-env-md.js` | 893 |

Plus 3 new (deployed-only) needing fresh `lib/config`-style refactor: `rh-learning-loop.js`, `rh-learnings-write.js`, `rh-supervisor-preload.js`.

---

## Substitution catalog (mechanical patterns)

For each script, apply these substitutions to the deployed-content base:

| Pattern (deployed) | Replacement (framework) |
|---|---|
| `process.env.HOME \|\| process.env.USERPROFILE \|\| ""` | (drop — use `config.home` if needed elsewhere) |
| `parseInt(process.env.RH_TELEMETRY_PORT \|\| process.env.PORT, 10) \|\| 7890` | `config.telemetryPort` |
| `` `http://localhost:${TELEMETRY_PORT}` `` | `config.telemetryUrl` |
| `path.join(HOME, ".claude", "scripts")` | `config.scriptsDir` |
| `path.join(HOME, ".claude", "agents")` | `config.agentsDir` |
| `path.join(HOME, ".claude", "skills")` | `config.skillsDir` |
| `path.join(HOME, ".claude", "settings.json")` | `config.settingsPath` |
| `path.join(HOME, ".claude", "hook-perf.jsonl")` | `config.perfLogPath` |
| `process.env.OVERSIGHT_LOG_PATH \|\| path.join(HOME, '.claude', 'telemetry-supervisory-log.md')` | `config.oversightLogPath` ⚠ default differs — see below |
| `process.env.OVERSIGHT_EVENTS_PATH \|\| path.join(HOME, '.claude', 'oversight-events.jsonl')` | `config.eventsLogPath` |
| Top of file | Add `const { config } = require('./lib/config');` (after other internal `require()`s) |

### ⚠ Default-path divergence to resolve before starting

| Field | Deployed default | Framework `lib/config.js` default |
|---|---|---|
| Oversight log | `~/.claude/telemetry-supervisory-log.md` | `~/.claude/oversight/supervisory-log.md` |

Currently moot in Ross's env (`OVERSIGHT_LOG_PATH` is set, both resolve to `claude-setup-ross/oversight-system/supervisory-log.md`). But for fresh installs, defaults diverge. **Decision needed:** align `lib/config.js` to use the deployed default (`~/.claude/telemetry-supervisory-log.md`), OR migrate deployed to the framework default.

---

## Phase plan (for the fresh session)

### F.1 — Pre-flight (15 min)
- [ ] Backup `~/.claude/scripts/` to `~/.claude/scripts.pre-reconcile-<timestamp>/`
- [ ] On `rh-claude-framework`, cut branch `chore/oversight-reconcile-with-deployed`
- [ ] Update `lib/config.js` `oversightLogPath` default to align with deployed (`~/.claude/telemetry-supervisory-log.md`) — OR document the migration path
- [ ] Add `lib/config.js` test exercising the new default

### F.2 — Per-file ports (~2 hours)
Order: smallest functional-diff first to validate the substitution pattern, then scale.

For each file:
1. Start with deployed content (already at `~/.claude/scripts/<file>`)
2. Apply substitution catalog above
3. Run `node --check <file>` for syntax
4. Run `node packages/oversight/tests/run.js` (16/16 baseline)
5. Commit one file at a time with title `port <file>: deployed→framework with lib/config abstraction`

### F.3 — New scripts refactor (30 min)
For each of `rh-learning-loop.js`, `rh-learnings-write.js`, `rh-supervisor-preload.js`:
1. Copy deployed → `packages/oversight/scripts/`
2. Apply substitution catalog
3. Add to package.json `files` field if not auto-included
4. Test: syntax + framework tests still pass

### F.4 — Parity verification (30 min)
- [ ] `rh-oversight init` against tmp HOME → 37/37 self-test from installed location
- [ ] **NEW**: diff `<tmp>/.claude/scripts/` vs current `~/.claude/scripts/` — characterize remaining differences (should be zero or only abstraction-equivalent)
- [ ] `node --check` every file in installed location
- [ ] Hooks fire end-to-end against installed copy (synthetic POST through hook-forwarder)

### F.5 — Live deploy (15 min, gated on F.4 passing)
- [ ] Confirm backup from F.1 still present
- [ ] Run `rh-oversight init` against Ross's real HOME — overwrites `~/.claude/scripts/`
- [ ] Verify Layer 3a hooks fire from new copies (trigger a Read in this session, check `hook-debug.log` for fresh entries with new content hash via `git hash-object`)
- [ ] Verify supervisor flags / behavior consistent

### F.6 — Cleanup (10 min)
- [ ] Open PR with detailed scope/risk note
- [ ] After merge, delete the pre-reconcile backup
- [ ] Update `PROGRESS.md` to mark item #1 + #2 fully closed (currently say ✅ but were on tmp HOME, not Ross's real HOME)

---

## Recovery posture

- F.1 backup is the rollback point. If F.5 deploy regresses anything, restore from backup.
- All commits in F.2 are per-file, so any single port can be reverted via `git revert <commit>`.
- `lib/config.js` change in F.1 is reversible without affecting deployed (deployed never imports it).

## Risk callouts

- **Hook regression risk** — these are the scripts that run on every tool use. A subtle substitution error could fail-open or fail-closed silently. Mitigations: per-file commits, syntax check, framework tests, install-then-self-test, and ultimately the live hooks firing in this session against the deployed copies.
- **Default-path divergence** — `oversightLogPath` is the known case; other paths may have similar divergences not yet checked. F.1 should grep both sides for any remaining default-default mismatches.
- **The 3 deployed-only scripts** may have hardcoded paths the substitution catalog doesn't cover. F.3 needs careful read of each before refactoring.

## Time estimate (fresh session)

| Phase | Estimate |
|---|---|
| F.1 Pre-flight | 15 min |
| F.2 Per-file ports (16 files) | 2 hours |
| F.3 New scripts refactor (3 files) | 30 min |
| F.4 Parity verification | 30 min |
| F.5 Live deploy | 15 min |
| F.6 Cleanup + PR | 10 min |
| **Total** | **~3.5 hours** in a focused session |

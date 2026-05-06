# PLAN — rh-claude-framework PROGRESS.md followups

**Created:** 2026-05-04
**Originating session:** post-rename-completion
**Scope:** Close items 1, 2, 5, 6, 7, 8 in `PROGRESS.md`. Items 9, 10 remain nice-to-have.
**Recovery posture:** All phases idempotent; checkbox tracking per step.

**Status:** ✅ ALL PHASES EXECUTED 2026-05-04 (same day). PROGRESS.md items 1, 2, 5, 6, 7, 8 closed. Phase D (telemetry migration) was gated for sign-off, user picked D-α + D-1 + D-i, executed via PR #3 (migration) + repo archive. Items 9, 10 remain nice-to-have as planned. The phase checkboxes below were the original plan; all are now done — kept as historical narrative.

| Phase | PR | Status |
|---|---|---|
| A — Validate init end-to-end | (verification only) | ✅ |
| B — Author CLAUDE.md + README.md | #2 | ✅ |
| C — PROGRESS.md fact corrections | #2 | ✅ |
| D — Telemetry migration | #3 | ✅ |

---

## Phase A — Validate `rh-oversight init` end-to-end (covers PROGRESS #1 + #2)

**Goal:** Run `rh-oversight init` without `--dry-run` against a tmp HOME and confirm the post-copy state actually works.

- [ ] A.1  Pick a tmp HOME path under `C:/Users/rossb/AppData/Local/Temp/` (Windows-native to avoid `/tmp` symlink quirks)
- [ ] A.2  Pre-create the tmp HOME with empty `.claude/` if `init` requires it
- [ ] A.3  Run `node packages/oversight/bin/rh-oversight.js init --workspace <tmp> --oversight-dir <tmp>/.claude/oversight --target-home <tmp>` (or whatever the exact flag set is — read `bin/rh-oversight.js` first to confirm)
- [ ] A.4  Verify outputs:
  - `<tmp>/.claude/scripts/rh-*.js` present
  - `<tmp>/.claude/agents/rh-*.md` present
  - `<tmp>/.claude/skills/rh-*/` present
  - `<tmp>/.claude/settings.json` has the framework's hooks merged (NOT overwritten if pre-existing)
  - `<tmp>/.claude/oversight.json` written with the workspace + oversight-dir values
- [ ] A.5  Run `node <tmp>/.claude/scripts/rh-oversight-self-test.js` — confirm relative `./lib/config` requires resolve from the installed location
- [ ] A.6  Capture verification token: paste verbatim the self-test summary line
- [ ] A.7  Failure recovery: if anything fails, the tmp HOME is disposable — `rm -rf` and re-run with corrections

**Outer seam:** the actual `rh-oversight init` CLI invocation against a real HOME (not the test runner mocking it).

**Verification:** self-test pass count from the **installed location**, not the source tree.

---

## Phase B — Author framework docs (PROGRESS #7 + #8)

**Goal:** README.md (user-facing install instructions) + CLAUDE.md (developer-facing internal docs) at the framework repo root.

- [ ] B.1  Write `rh-claude-framework/README.md`:
  - One-line description
  - Install: `npm install -g rh-claude-framework` (placeholder — verify package name) + `rh-oversight init`
  - What `rh-oversight init` does (high-level: copies scripts, merges hooks, writes oversight.json)
  - Reset: `rh-oversight reset` (if implemented)
  - Self-test: `rh-oversight self-test`
  - Architecture: monorepo, two packages, link to per-package READMEs
- [ ] B.2  Write `rh-claude-framework/CLAUDE.md`:
  - Project goals (portable oversight + portable telemetry)
  - Repo layout (packages/oversight, packages/telemetry placeholder)
  - Pickup commands (the same block already in `PROGRESS.md` "How to pick up")
  - Decision pointers (link `packages/oversight/scripts/lib/config.js` for config priority, etc.)
- [ ] B.3  Verify both render in a markdown previewer / GitHub web — no broken links
- [ ] B.4  No tests required for prose changes; smoke check rendering only

---

## Phase C — Fact corrections to PROGRESS.md (covers PROGRESS #6 + housekeeping)

**Goal:** Bring PROGRESS.md current with reality after this session.

- [ ] C.1  #6 — "Initial git commit — everything is staged but not committed" is **stale**. Framework has commits `9c3455f` (initial) + `85c82ab` (rename) + `8745c69` (merge). Update to past-tense + reference commits.
- [ ] C.2  #1 — mark ✅ with verification token from Phase A.6 if Phase A passes
- [ ] C.3  #2 — mark ✅ with verification token from Phase A.5
- [ ] C.4  #7, #8 — mark ✅ with paths to the new files
- [ ] C.5  Update "Last session" date and any other stale timestamps

**Per `rh-replacement-assessment.md`:** these are fact corrections (description vs. current state mismatches), not removal of decisions — no assessment template required.

---

## Phase D — Telemetry migration (PROGRESS #5) — REQUIRES STRATEGIC SIGN-OFF

**This phase is destructive and irreversible.** Pause and surface options before executing.

### Strategic decisions before executing

1. **History preservation method:**
   - **D-α  Copy without history** — `cp -r rh-telemetry/* packages/telemetry/`. Simple, but loses 25-commit history at the new path.
   - **D-β  `git subtree add`** — preserve history at the new path. Larger one-time merge commit; future cross-repo sync via `git subtree push/pull`.
   - **D-γ  `git filter-repo` + import** — surgical history rewrite. Most invasive.
   - **Recommendation:** D-β. Preserves blame/history; no double-source-of-truth ambiguity going forward.

2. **rh-telemetry GitHub repo retirement:**
   - **D-1  Archive only** — set `archived=true` on `toolbeltross/rh-telemetry`. URL still resolves; clones become read-only.
   - **D-2  Delete after grace period** — archive for 30 days, then `gh repo delete`.
   - **D-3  Keep as redirect** — leave active but freeze content with a README pointing at the framework. Cleanest for downstream consumers.
   - **Recommendation:** D-1 (archive). Reversible. Defer delete decision to later.

3. **npm publish source after migration:**
   - **D-i  Publish from `rh-claude-framework/packages/telemetry/`** — single source of truth. Update `package.json` repository URL to the framework repo + subpath.
   - **D-ii  Continue publishing from rh-telemetry repo** — requires keeping rh-telemetry alive as the publish artifact, conflicting with retirement.
   - **Recommendation:** D-i. Aligns with monorepo intent + the "one canonical name" principle.

### Execution checklist (after sign-off)

- [ ] D.4  Verify `rh-telemetry` working tree is clean + on `main` + synced with `origin/main`
- [ ] D.5  In `rh-claude-framework`: `git subtree add --prefix=packages/telemetry https://github.com/toolbeltross/rh-telemetry.git main` (D-β)
- [ ] D.6  Resolve any path collisions in shared lib code (e.g., does `packages/telemetry/scripts/hook-forwarder.js` shadow `packages/oversight/scripts/lib/...`?)
- [ ] D.7  Parameterize hardcoded paths in `packages/telemetry/scripts/setup-hooks.js` lines 122-127 (rule citations) — mirror the oversight package's config-resolution pattern
- [ ] D.8  Update `packages/telemetry/package.json`:
  - `name` stays `rh-telemetry`
  - `repository.url` → `https://github.com/toolbeltross/rh-claude-framework` + `directory: packages/telemetry`
- [ ] D.9  Update root `package.json` workspaces field if not already
- [ ] D.10 Run both test suites from monorepo root:
  - `node packages/oversight/tests/run.js` (expect 16/16)
  - `node packages/telemetry/tests/run.js` (expect 25/25)
- [ ] D.11 Run `rh-oversight init --dry-run` — verify it still surfaces both packages' assets
- [ ] D.12 Settings.json hook paths continue to point at the OLD `rh-telemetry/` location until cutover; do NOT flip yet — leave Ross's working setup intact
- [ ] D.13 Commit the subtree merge + parameterization fixes
- [ ] D.14 Push as feature branch `chore/migrate-telemetry-to-monorepo`, open PR, merge after self-review

### Cutover (separate later session — NOT this plan)

- [ ] (Out of scope for this plan) Flip `~/.claude/settings.json` hook paths from `rh-telemetry/` → `rh-claude-framework/packages/telemetry/`
- [ ] (Out of scope) Archive `toolbeltross/rh-telemetry` GitHub repo per D-1

---

## What is VERIFIED via outer seam

(populated as phases complete)

| Item | Verification |
|---|---|
| TBD | TBD |

## What is PARTIAL (not verified via outer seam)

(populated as phases complete)

| Item | Status | Linked phase |
|---|---|---|

---

## Recovery notes

- All phases idempotent. Re-running an already-completed step is a no-op.
- Phase A uses tmp HOME — no impact on Ross's live `~/.claude/`.
- Phase B is pure content addition.
- Phase C is fact correction — covered by the `rh-replacement-assessment.md` carve-out.
- Phase D is destructive; sign-off gate before executing D.4 onward.

## Time estimates

- Phase A: 15 min (mostly reading bin/rh-oversight.js to get flags right + tmp HOME setup)
- Phase B: 25 min
- Phase C: 5 min
- Phase D (post-sign-off): 30–60 min depending on path collisions

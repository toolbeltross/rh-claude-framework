# PLAN — Propagate 2026-06-14 placement/scribe edits into rh-claude-framework source

> **Created:** 2026-06-15 · **Status:** not started · **Origin:** edits made 2026-06-14 in a session rooted in `rh-platform-agentbuild`; already merged there (PR #59). This plan is ONLY the framework-source propagation.

## Context (why this exists)

A 2026-06-14 session added a global file-placement convention + hardened the scribe agents + extended the oversight state-doc generator. Those changes were applied to the **deployed copies** (`~/.claude/scripts`, `~/.claude/agents`, `<workspace>/.claude/rules`). **This repo is the deploy source** — `rh-oversight init` copies the package sources OVER the deployed files, so the edits will be **clobbered on the next deploy** unless they land here. The deployed copies are the exact reference for what changed.

## Preconditions

- Read this repo's `CLAUDE.md`. Honor: the zero-hardcoded-paths grep must stay CLEAN —
  ```bash
  grep -r "rossb\|C:/Users/rossb\|OneDrive/Workspace\|claude-setup-ross\|toolbeltross" --include="*.js" --include="*.md" --include="*.json" packages/
  ```
  CJS only; every framework artifact is `rh-` prefixed.
- The repo may be checked out on `chore/session-state-refresh` (another session's branch). Per `rh-multi-session.md`, create a fresh `git worktree` off `main` and work there — do NOT commit into the existing checkout.

## Ports (target source ← reference deployed copy to mirror exactly)

1. **NEW FILE** `packages/oversight/rules/rh-doc-placement.md`
   ← `C:\Users\rossb\OneDrive\Workspace\.claude\rules\rh-doc-placement.md` (copy verbatim — global docs/data/temp/project-tracking/**memory** placement convention + a **Frontmatter conventions** section + **organic-adoption** framing).
   THEN **wire it into the installer** so it actually deploys to `<workspace>/.claude/rules/`: inspect `packages/cli/lib/init.js` + `packages/cli/templates` + any per-package install manifest, and add `rh-doc-placement.md` to whatever list enumerates the rule files copied to the workspace. **If rules are copied by directory glob, no wiring is needed — VERIFY which it is.** ("New rule silently never deploys" is the one easy failure here.)

2. `packages/output/scripts/rh-generate-state-md.js`
   ← `C:\Users\rossb\.claude\scripts\rh-generate-state-md.js`
   Add the additive `sectionRulesDomainIndex()` function (emits a "Rule → domain (keywords)" markdown table from each rule's `keywords:`/`description:` frontmatter) and wire it into `main()`'s sections array immediately after `sectionRulesInPlace()`. Pure-additive, CJS, no hardcoded paths.

3. `packages/oversight/agents/rh-scribe-recommendations.md` AND `rh-scribe-cleanup-items.md`
   ← `C:\Users\rossb\.claude\agents\rh-scribe-recommendations.md` / `rh-scribe-cleanup-items.md`
   Add the "Resolve the canonical workspace FIRST (deterministic, NOT from CWD)" callout before the write steps: resolve `$WORKSPACE` via `config.workspace`, use `"$WORKSPACE/<file>"` for every read/append/sentinel op, never a bare relative filename. (Root-cause fix for the scribe cwd-walkup misfire; the multiscope agent already had this resolution.)

4. `packages/oversight/agents/rh-scribe-multiscope.md`
   ← `C:\Users\rossb\.claude\agents\rh-scribe-multiscope.md`
   Add the "Step 4b — Rule-domain breadcrumb" step (append ` → candidate home: <rule>.md` to captured items that propose a durable convention; point at the Rules Domain Index in `OVERSIGHT_STATE.md` as the keyword→rule lookup). Lightweight hint, not hard routing.

5. `packages/oversight/rules/rh-conventions.md`, `rh-cwd-awareness.md`, `rh-oversight-doc-sync.md`
   ← `C:\Users\rossb\OneDrive\Workspace\.claude\rules\{same names}`
   Add the back-references to `rh-doc-placement.md`. In `rh-oversight-doc-sync.md` also add the sync-points row ("New/changed placement convention → extend `rh-doc-placement.md`, not a new rule file") and fix the stale "The 9 workspace rule files" count to the current count.

6. **FLAG (do NOT auto-fix):** `rh-throwaway-artifacts.md` is deployed but **NOT tracked in this framework repo** (pre-existing drift). Decide whether to add it to the framework source too, or leave as-is — surface to the user with a recommendation.

## Verify (this repo's outer-seam bar — per its CLAUDE.md)

- `node packages/oversight/tests/run.js` (expect 76)
- `node packages/cli/tests/run.js` (expect 43)
- `node packages/output/tests/run.js` (expect 1)
- the zero-hardcoded-paths grep above must be CLEAN
- `node packages/cli/bin/rh-oversight.js init --dry-run`
- ideally a real tmp-HOME install: `HOME=/tmp/test USERPROFILE=/tmp/test node packages/cli/bin/rh-oversight.js init --workspace /tmp/test-ws` — then CONFIRM `rh-doc-placement.md` actually landed in `/tmp/test-ws/.claude/rules/`.

Then open a PR. **Do not declare done** until the tests pass and the install dry-run/real-install shows the new rule deploying.

## Done-when

- [ ] 6 ports applied in a worktree off `main`
- [ ] `rh-doc-placement.md` confirmed to deploy (installer wiring or glob verified)
- [ ] 76 + 43 + 1 tests pass; zero-hardcoded-paths grep clean
- [ ] `rh-throwaway-artifacts.md` drift surfaced with a recommendation
- [ ] PR opened

# rh-claude-framework — Progress & Pickup Notes

**Last session:** 2026-05-04
**Repo:** `C:\Users\rossb\OneDrive\Workspace\toolbeltross\toolbeltross-public\rh-claude-framework\`
**Branch:** `main` — 3 commits (initial `9c3455f`, rename `85c82ab`, merge `8745c69`)

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
| packages/telemetry/ | Stub dir only | Placeholder | Not started |

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

5. **Migrate telemetry project** into `packages/telemetry/` — the telemetry project at `rh-telemetry/` should move in as the second workspace package. Its `setup-hooks.js` also has hardcoded paths (supervisory prompt rule citations at lines 122-127). See [`PLAN-20260504-framework-followups.md`](PLAN-20260504-framework-followups.md) Phase D for strategic options + execution checklist.
6. ✅ **Initial git commit** — done in a prior session (commit `9c3455f`). This session added 2 more commits (rename `85c82ab`, merge `8745c69`).
7. ✅ **CLAUDE.md for the framework repo itself** — [`CLAUDE.md`](CLAUDE.md) authored 2026-05-04
8. ✅ **README.md** with install instructions — [`README.md`](README.md) authored 2026-05-04

### Nice-to-have

9. Integration test: spawn `rh-oversight init` against a tmp HOME, then run self-test from the installed location *(Phase A of PLAN-20260504-framework-followups.md performed this manually; codifying it as a repeatable test is still pending)*
10. npm link / npm pack testing for global install path

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

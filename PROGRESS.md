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

11. **`rh-oversight init` overwrites Stop hooks added by `rh-telemetry setup`.** Discovered 2026-05-06: on 2026-05-04, running `rh-oversight init` after `rh-telemetry setup` clobbered `hook-forwarder.js stop` from the Stop chain in `~/.claude/settings.json`. The supervisory log silently went 3 days without entries. The framework's Stop template (`packages/oversight/templates/settings.json.template`) intentionally doesn't include `hook-forwarder.js stop` because not all installs have rh-telemetry — but `lib/init.js`'s merge logic (`existingHooks[phase][existingIdx] = newEntry; // exact match — replace`) ends up replacing the entire Stop chain rather than additively merging telemetry's hooks alongside the oversight ones. Workaround: re-run `rh-telemetry setup` after `rh-oversight init`. Proper fix: change init.js to additively merge Stop hook entries that don't match its own signature, OR document the required ordering. Detection of this class of failure is now covered by the `journal_staleness_alert` probe in `rh-daily-regen-trigger.js` (added 2026-05-06).

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

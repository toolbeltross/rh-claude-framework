# CLAUDE.md — rh-claude-framework

Internal reference for Claude Code sessions working on this repo. User-facing docs live in [`README.md`](README.md).

## Repo layout

```
rh-claude-framework/
├── package.json                    # npm workspaces root
├── PROGRESS.md                     # current state + outstanding work
├── PLAN-*.md                       # in-flight plan files (per-session)
└── packages/
    ├── shared/                     # @rh/shared — canonical infra
    │   ├── config.js               # path/env resolution (was lib/config.js); `scribeStaging` flag
    │   ├── file-lock.js            # cross-process atomic lockfile (O_EXCL + PID + 5s stale recovery)
    │   └── env.js                  # homeDir/claudeDir/parseEnvVar helpers
    │
    ├── oversight/                  # rh-claude-oversight — enforcement only
    │   ├── scripts/                # rh-*.js guards/hooks/utilities (copied to ~/.claude/scripts/)
    │   ├── scripts/lib/            # SHIMS for {config,file-lock} re-exporting from @rh/shared (source-tree only — installer overwrites with shared canonical)
    │   ├── scripts/lib/scribe-staging.js     # per-turn staging file lib (P1-3)
    │   ├── scripts/lib/settings-validator.js # pure schema validator (P2-4)
    │   ├── scripts/rh-supervisor-sweep.js    # cross-session trend doc (P3-1)
    │   ├── scripts/rh-scribe-staging-read.js # /rh-quit consumer for staged turns (P1-3)
    │   ├── agents/                 # rh-*.md agent definitions (copied to ~/.claude/agents/)
    │   ├── rules/                  # workspace rule files (copied to <workspace>/.claude/rules/)
    │   ├── templates/journals.json # runtime journal config (NOT an install template)
    │   └── tests/                  # config + guard + scribe-staging + settings-validator + supervisor-sweep (76 tests)
    │
    ├── output/                     # @rh/output — rendered artifacts + scribe writers
    │   ├── scripts/rh-render-md-html.js        # md → styled HTML, withLock-wrapped writes
    │   ├── scripts/rh-generate-state-md.js     # OVERSIGHT_STATE.md generator, withLock-wrapped
    │   ├── scripts/rh-generate-env-md.js       # ENVIRONMENT.md generator
    │   ├── scripts/rh-daily-regen.js           # orchestrator; markRanToday() now withLock
    │   ├── scripts/rh-daily-regen-trigger.js   # SessionStart hook entry
    │   ├── scripts/rh-scribe-table-write.js    # atomic row appender CLI helper
    │   ├── scripts/rh-learnings-write.js       # learnings file writer
    │   ├── scripts/rh-auto-prune.js            # scribe row pruning
    │   └── tests/test-concurrent-write.js      # 16-way bash-parallel stress (1 test)
    │
    ├── skills/                     # @rh/skills — user-invocable surfaces
    │   ├── rh-quit/SKILL.md        # /rh-quit — scribe drain at session end
    │   └── rh-session/             # /session — current-session inventory
    │
    ├── cli/                        # @rh/cli — meta-installer + settings CLI
    │   ├── bin/rh-oversight.js     # CLI entry (init / reset / self-test / settings / supervisor-sweep / health)
    │   ├── lib/init.js             # install logic + mergeHooksData (F-10 fix) + pre-write validator gate (P2-4)
    │   ├── lib/settings-cli.js     # `rh-oversight settings <sub>` (validate/show/diff/merge/backup/restore)
    │   ├── templates/              # settings.json + CLAUDE.md templates
    │   └── tests/                  # init-merge + cross-package-contract + settings-cli (43 tests)
    │
    └── telemetry/                  # rh-telemetry (migrated 2026-05-04; canonical home — standalone repo archived)
        ├── server/trends-router.js          # GET /api/trends — cross-package wrap of supervisor-sweep (P3-2)
        ├── src/components/TrendsTab.jsx     # Dashboard "Trends" tab (P3-2)
        └── docs/STYLEGUIDE.md               # canonical visual-system reference (PR #20)
```

**5-package reorg landed 2026-05-11** (PRs #21, #22, #23):
- Phase 1 (#21): extract `packages/shared/` (config, file-lock, env)
- Phase 2 (#21): extract `packages/output/` + harden 3 unlocked writers
- Phase 3 (#22): extract `packages/skills/`
- Phase 4 (#23): extract `packages/cli/` (installer + bin + templates)
- Phase 5 follow-up: per-package `install.json` manifest decomposition (deferred)

## Conventions

- **Zero hardcoded user paths** — every path goes through `@rh/shared/config`. Verify via:
  ```bash
  grep -r "rossb\|C:/Users/rossb\|OneDrive/Workspace\|claude-setup-ross\|toolbeltross" \
    --include="*.js" --include="*.md" --include="*.json" packages/
  ```
  Result must be CLEAN.
- **CJS only** — `require()` / `module.exports`. Matches the installed scripts target environment. Telemetry is the single ESM exception (uses dynamic import / subprocess to bridge).
- **`rh-` prefix** on every framework artifact — distinguishes framework-installed files from user's local edits.
- **Config priority** — env var > `~/.claude/oversight.json` > auto-detect from CWD.
- **Source-tree shims** — `packages/oversight/scripts/lib/{config,file-lock}.js` re-export from `@rh/shared`. The installer overwrites these with the canonical files at install time, so post-install `~/.claude/scripts/lib/` has self-contained modules with no relative `../../../shared/` dependency.

## How to test changes

| Surface | Command |
|---|---|
| Oversight tests | `node packages/oversight/tests/run.js` (76 tests) |
| CLI tests | `node packages/cli/tests/run.js` (43 tests) |
| Output tests | `node packages/output/tests/run.js` (1 test — concurrent write stress) |
| All workspace tests | `npm test` |
| Dry-run install | `node packages/cli/bin/rh-oversight.js init --dry-run` |
| Real install against tmp HOME | `HOME=/tmp/test USERPROFILE=/tmp/test node packages/cli/bin/rh-oversight.js init --workspace /tmp/test-ws` |
| Self-test from installed location | `HOME=/tmp/test node /tmp/test/.claude/scripts/rh-oversight-self-test.js` (37/37 hard pass) |

The "tmp HOME" pattern is the outer-seam verification per `rh-work-verification.md`. Don't rely solely on the test runner — exercise the actual `rh-oversight init` CLI against a disposable home dir.

## Key architectural decisions

- **5-package reorg (2026-05-11, PRs #21–23)** — shared / oversight / output / skills / cli / telemetry. Separates infrastructure (shared) from enforcement (oversight) from rendered output (output) from user surfaces (skills) from install logic (cli). Telemetry already standalone. Plan: `plans/do-some-analysis-on-iridescent-clock.md`.
- **Telemetry migration via subtree** — preserves history at the new path. See `PLAN-20260504-framework-followups.md` Phase D.
- **`rh-security.md` split** — base file ships with the framework; `rh-security-local.md.template` is the user-private dirs list, gitignored at install time.
- **Generators use configurable `oversightDir`** — defaults to `~/.claude/oversight/`. Ross's local config points to `claude-setup-ross/oversight-system/`.
- **Settings.json pre-write validator (P2-4)** — `cli/lib/init.js` runs `validateSettings()` on the fully-merged object before any write. Errors abort without modifying the live file; warnings surface but allow.
- **Per-turn scribe staging (P1-3)** — on by default. Disable via `RH_SCRIBE_STAGING=0` or `oversight.json:scribeStaging:false`.
- **Cross-package trends (P3-2)** — telemetry server bridges to the CJS sweep module via `createRequire`. Single canonical aggregation; both `rh-oversight supervisor-sweep` and `GET /api/trends` produce the same data.
- **Concurrency hardening (Phase 2 reorg)** — full-file writers in output package wrap writes in `withLock` for cross-process safety. Documented exception: `rh-daily-regen.js` LOG_PATH append stays unlocked under JSONL atomic-append assumption (single-process under same-day guard).

## Pickup commands

```bash
cd C:/Users/rossb/OneDrive/Workspace/toolbeltross/toolbeltross-public/rh-claude-framework
node packages/oversight/tests/run.js   # 76 expected
node packages/cli/tests/run.js         # 43 expected
node packages/output/tests/run.js      # 1 expected
node packages/cli/bin/rh-oversight.js init --dry-run
grep -r "rossb\|C:/Users/rossb" --include="*.js" --include="*.md" packages/   # must be empty
```

## Out of scope for this repo

- Per-user customization (lives in `~/.claude/oversight.json` after `init`)
- Per-workspace `CLAUDE.md` content (the `init` writes a starter; user owns it from there)
- Project-specific agents that aren't framework-level (live in the user's `<project>/.claude/agents/`)

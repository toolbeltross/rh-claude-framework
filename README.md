# rh-claude-framework

Portable Claude Code oversight framework + telemetry dashboard, packaged as a monorepo.

## Packages

| Package | npm name | Purpose |
|---|---|---|
| [`packages/shared`](packages/shared/) | `@rh/shared` | Canonical config + cross-process file lock + env helpers |
| [`packages/oversight`](packages/oversight/) | `rh-claude-oversight` | Enforcement scripts, agents, workspace rules |
| [`packages/output`](packages/output/) | `@rh/output` | Rendered artifacts (HTML dashboards, scribe writers, daily-regen) |
| [`packages/skills`](packages/skills/) | `@rh/skills` | User-invocable skills (`/rh-quit`, `/rh-session`) |
| [`packages/cli`](packages/cli/) | `@rh/cli` | Meta-installer + `rh-oversight` CLI + settings tooling |
| [`packages/telemetry`](packages/telemetry/) | `rh-telemetry` | Real-time monitoring dashboard for Claude Code sessions |

The 5-package reorg landed 2026-05-11 (PRs #21–23). Install logic, output rendering, skills, and shared infrastructure live in their own peer packages alongside `oversight` and `telemetry`.

## Install

```bash
# From a checkout
node packages/cli/bin/rh-oversight.js init [--workspace <path>] [--oversight-dir <path>] [--private-dirs <comma,list>]

# Or via npm (after publish)
npm install -g @rh/cli
rh-oversight init
```

`init` does:

1. Writes `~/.claude/oversight.json` (workspace + oversight-dir + telemetry port)
2. Copies `rh-*` enforcement scripts → `~/.claude/scripts/`
3. Copies `rh-*` agent definitions → `~/.claude/agents/`
4. Copies `rh-*` skill definitions → `~/.claude/skills/`
5. Copies workspace rules → `<workspace>/.claude/rules/`
6. Merges hooks into `~/.claude/settings.json` (additive — preserves your existing entries by matcher)
7. Writes a starter `<workspace>/CLAUDE.md` if one doesn't exist

Useful flags: `--dry-run`, `--skip-hooks`.

## Verify

```bash
rh-oversight self-test
```

Expected on a healthy install: `oversight-self-test: 37/37 hard passed`.

## CLI subcommands

| Command | Purpose |
|---|---|
| `rh-oversight init` | Install / re-deploy framework artifacts (see "Install" above) |
| `rh-oversight reset` | Reinstall while preserving `oversight.json` |
| `rh-oversight self-test` | Health check — 37/37 hard pass expected |
| `rh-oversight health [--json]` | One-screen aggregator (regen + journals + telemetry + alerts + scribe backlog + subagent orphans) |
| `rh-oversight generate-state` | Regenerate `<oversight-dir>/OVERSIGHT_STATE.md` (filesystem snapshot of rules/hooks/agents) |
| `rh-oversight generate-env` | Regenerate `<workspace>/claude-setup-ross/environment/ENVIRONMENT.md` |
| `rh-oversight settings <sub>` | Merge-aware CLI for `settings.json`. Subcommands: `validate / show / diff / merge / backup / restore`. Run `rh-oversight settings --help`. Validator rejects shape errors before write; `merge` defaults to dry-run, requires `--apply` to write, and creates a timestamped backup. (P2-4) |
| `rh-oversight supervisor-sweep [--days N]` | Cross-session/project trend doc. Reads `~/.claude/oversight-events.jsonl` + supervisory-log Layer3a rejections over a sliding window (default 7 days, capped at 90); writes `~/.claude/memory-shared/supervisor-trends.md`. Flags: `--out <path>`, `--json`, `--dry-run`. (P3-1) |

## Per-turn scribe staging (P1-3)

Default-off. Set `RH_SCRIBE_STAGING=1` in your `~/.claude/settings.json` env (or `scribeStaging: true` in `~/.claude/oversight.json`) to enable. When enabled, the prefilter writes the bytes appended to the transcript on each Stop to a per-session JSONL file under `~/.claude/scribe-staging/`. `/rh-quit` consumes the full staging file for end-of-session true-up instead of the 10K-char tail.

Inspect with:
```bash
node ~/.claude/scripts/rh-scribe-staging-read.js <session-id> --stats
node ~/.claude/scripts/rh-scribe-staging-read.js <session-id>          # full text
node ~/.claude/scripts/rh-scribe-staging-read.js <session-id> --clear  # delete after consumption
```

## Reset

```bash
rh-oversight reset
```

Removes installed `rh-*` scripts and reinstalls. Preserves `oversight.json`.

## Architecture

- **Monorepo** — npm workspaces with 6 packages: `shared`, `oversight`, `output`, `skills`, `cli`, `telemetry`.
- **Zero hardcoded user paths** — all references parameterized through `@rh/shared/config`. Verified via `grep -r "rossb\|C:/Users/rossb\|OneDrive" packages/` returning no matches.
- **CommonJS** throughout (`require()`); telemetry is the single ESM exception.
- **Config priority**: env var > `~/.claude/oversight.json` > auto-detect (walk up from CWD looking for `.claude/rules/`).
- **Security split**: `rh-security.md` (framework base) + `rh-security-local.md.template` (user's private dirs, gitignored at install time).
- **Cross-process file locking**: `@rh/shared/file-lock` provides atomic O_EXCL lockfiles with PID stamping + 5s stale recovery. Used by all output writers and scribe table writes.

## Development

```bash
# Tests by package
node packages/oversight/tests/run.js   # 76 tests
node packages/cli/tests/run.js         # 43 tests
node packages/output/tests/run.js      # 1 test (16-way concurrent stress)

# All workspaces
npm test

# Dry-run install
node packages/cli/bin/rh-oversight.js init --dry-run
```

See [`PROGRESS.md`](PROGRESS.md) for the current state of each component and outstanding work.

## License

MIT

# rh-claude-framework

Portable Claude Code oversight framework + telemetry dashboard, packaged as a monorepo.

## Packages

| Package | npm name | Purpose | Status |
|---|---|---|---|
| [`packages/oversight`](packages/oversight/) | `rh-claude-oversight` | Enforcement scripts, agents, rules, and the `rh-oversight` setup CLI | Working — installed via `rh-oversight init` |
| [`packages/telemetry`](packages/telemetry/) | `rh-telemetry` | Real-time monitoring dashboard for Claude Code sessions | Stub — migration tracked in `PROGRESS.md` item #5 |

## Install (oversight package)

```bash
# From a checkout
node packages/oversight/bin/rh-oversight.js init [--workspace <path>] [--oversight-dir <path>] [--private-dirs <comma,list>]

# Or via npm (after publish)
npm install -g rh-claude-oversight
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

## Reset

```bash
rh-oversight reset
```

Removes installed `rh-*` scripts and reinstalls. Preserves `oversight.json`.

## Architecture

- **Monorepo** — npm workspaces; root `package.json` declares `packages/oversight` + `packages/telemetry`.
- **Zero hardcoded user paths** — all references parameterized through `packages/oversight/scripts/lib/config.js`. Verified via `grep -r "rossb\|C:/Users/rossb\|OneDrive" packages/` returning no matches.
- **CommonJS** throughout (`require()`).
- **Config priority**: env var > `~/.claude/oversight.json` > auto-detect (walk up from CWD looking for `.claude/rules/`).
- **Security split**: `rh-security.md` (framework base) + `rh-security-local.md.template` (user's private dirs, gitignored at install time).

## Development

```bash
# Tests (oversight package)
node packages/oversight/tests/run.js

# Or via the workspace script
npm run test:oversight

# Dry-run install
node packages/oversight/bin/rh-oversight.js init --dry-run
```

See [`PROGRESS.md`](PROGRESS.md) for the current state of each component and outstanding work.

## License

MIT

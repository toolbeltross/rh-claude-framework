# CLAUDE.md — rh-claude-framework

Internal reference for Claude Code sessions working on this repo. User-facing docs live in [`README.md`](README.md).

## Repo layout

```
rh-claude-framework/
├── package.json                    # npm workspaces root
├── PROGRESS.md                     # current state + outstanding work
├── PLAN-*.md                       # in-flight plan files (per-session)
└── packages/
    ├── oversight/                  # rh-claude-oversight (working)
    │   ├── bin/rh-oversight.js     # CLI entry — init / reset / self-test / generate-*
    │   ├── lib/init.js             # core install logic
    │   ├── scripts/                # rh-*.js enforcement scripts (copied to ~/.claude/scripts/)
    │   ├── scripts/lib/config.js   # canonical config-resolution module
    │   ├── agents/                 # rh-*.md agent definitions (copied to ~/.claude/agents/)
    │   ├── skills/                 # rh-*/SKILL.md skill bundles
    │   ├── rules/                  # workspace rule files (copied to <workspace>/.claude/rules/)
    │   ├── templates/              # settings.json + CLAUDE.md templates
    │   └── tests/                  # config + guard test suites
    └── telemetry/                  # rh-telemetry (stub — migration pending)
```

## Conventions

- **Zero hardcoded user paths** — every path goes through `scripts/lib/config.js`. Verify via:
  ```bash
  grep -r "rossb\|C:/Users/rossb\|OneDrive/Workspace\|claude-setup-ross\|toolbeltross" \
    --include="*.js" --include="*.md" --include="*.json" packages/
  ```
  Result must be CLEAN.
- **CJS only** — `require()` / `module.exports`. Matches the installed scripts target environment.
- **`rh-` prefix** on every framework artifact — distinguishes framework-installed files from user's local edits.
- **Config priority** — env var > `~/.claude/oversight.json` > auto-detect from CWD.

## How to test changes

| Surface | Command |
|---|---|
| Unit + guard tests | `node packages/oversight/tests/run.js` |
| Dry-run install | `node packages/oversight/bin/rh-oversight.js init --dry-run` |
| Real install against tmp HOME | `HOME=/tmp/test USERPROFILE=/tmp/test node packages/oversight/bin/rh-oversight.js init --workspace /tmp/test-ws` |
| Self-test from installed location | `HOME=/tmp/test node /tmp/test/.claude/scripts/rh-oversight-self-test.js` |

The "tmp HOME" pattern is the outer-seam verification per `rh-work-verification.md`. Don't rely solely on the test runner — exercise the actual `rh-oversight init` CLI against a disposable home dir.

## Key architectural decisions

- **One repo, two packages** (oversight + telemetry). Decided 2026-05-02.
- **Telemetry migration via subtree (recommended)** — preserves history at the new path. See `PLAN-20260504-framework-followups.md` Phase D for the strategic options.
- **`rh-security.md` split** — base file ships with the framework; `rh-security-local.md.template` is the user-private dirs list, gitignored at install time.
- **Generators use configurable `oversightDir`** — defaults to `~/.claude/oversight/`. Ross's local config points to `claude-setup-ross/oversight-system/`.

## Pickup commands

```bash
cd C:/Users/rossb/OneDrive/Workspace/toolbeltross/toolbeltross-public/rh-claude-framework
node packages/oversight/tests/run.js                  # 16/16 expected
node packages/oversight/bin/rh-oversight.js init --dry-run
grep -r "rossb\|C:/Users/rossb" --include="*.js" --include="*.md" packages/   # must be empty
```

## Out of scope for this repo

- Per-user customization (lives in `~/.claude/oversight.json` after `init`)
- Per-workspace `CLAUDE.md` content (the `init` writes a starter; user owns it from there)
- Project-specific agents that aren't framework-level (live in the user's `<project>/.claude/agents/`)

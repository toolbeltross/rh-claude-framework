# Contributing to rh-claude-framework

Thanks for your interest! This is a CommonJS npm-workspaces monorepo (telemetry
is the one ESM package). Internal architecture notes live in
[`CLAUDE.md`](CLAUDE.md); this file is the practical how-to for contributors.

## Getting started

**Prerequisites:** [git](https://git-scm.com/), **Node.js ≥ 20** (the dashboard
build — Vite 6 + Tailwind v4 — is validated on 20+; the package floor is 18), and
[Claude Code](https://claude.com/claude-code) if you want to exercise hooks.

```bash
git clone https://github.com/toolbeltross/rh-claude-framework
cd rh-claude-framework
npm install        # also builds both dashboard bundles via the root prepare script
```

> On Windows, if your clone path is deep or has spaces:
> `git config --global core.longpaths true`.

## Running the tests

```bash
npm test                                  # all workspaces (unit + integration)
node packages/oversight/tests/run.js      # 207 tests
node packages/cli/tests/run.js            # 83 tests
node packages/output/tests/run.js         # 205 tests (incl. 16-way concurrent stress)
node packages/telemetry/tests/run.js      # telemetry unit + integration
node packages/cli/bin/rh-oversight.js self-test   # 37/37 hard pass
```

CI (`.github/workflows/ci.yml`) runs `npm test` + the self-test on Ubuntu and
Windows (Node 20/22) for every push and PR.

### Outer-seam verification (please do this)

Unit tests pass without an install; they will **not** catch a broken installer.
For any change that touches the installer, shared `config`, or the deployed
scripts, exercise the real CLI against a throwaway HOME — the canonical check:

```bash
HOME=/tmp/test USERPROFILE=/tmp/test \
  node packages/cli/bin/rh-oversight.js init --workspace /tmp/test-ws
HOME=/tmp/test node /tmp/test/.claude/scripts/rh-oversight-self-test.js   # 37/37
```

(A recent change added a new `@rh/shared` module that `config.js` required but
the installer didn't ship — `npm test` stayed green while every installed script
crashed. Only the tmp-HOME install caught it.)

## Conventions

- **CommonJS** (`require`/`module.exports`) everywhere except `packages/telemetry`.
- **`rh-` prefix** on every framework-installed artifact.
- **Zero hardcoded user paths.** All paths resolve through `@rh/shared/config`
  (`config.claudeDir`, `config.workspace`, …). No absolute home paths in
  `packages/`. Enforced by `packages/cli/tests/test-no-identity-refs.js`
  (which also catches split-arg forms like `path.join(..., 'OneDrive', ...)`).
- **Atomic config writes.** Replace config files with `writeFileAtomic` from
  `@rh/shared` (temp + rename), never a bare `fs.writeFileSync` — an interrupted
  write must not truncate a user's `settings.json`.
- **`withLock` for shared-file read-modify-write.** The callback does its own
  read **and** write inside the lock (see `@rh/shared/file-lock` and
  `rh-scribe-table-write.js`).
- **Hooks must stay cheap and fail open** — they run on every tool call.

## Commits & pull requests

- One focused change per PR (see the existing history for the grain).
- **Conventional commit** subjects: `fix(cli): …`, `feat(telemetry): …`,
  `docs: …`, `ci: …`.
- Update or add a test for behavioral changes, and update the counts in
  `README.md` / `CLAUDE.md` if you add tests.
- Run the relevant suite (and, for installer-adjacent work, the tmp-HOME
  install) before opening the PR, and say what you verified.

## Security

Please report vulnerabilities privately — see [`SECURITY.md`](SECURITY.md). Do
not open a public issue for security reports.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).

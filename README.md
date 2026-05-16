# rh-claude-framework

A production Claude Code oversight framework: 10 reusable enforcement patterns, 25 hook scripts, 19 specialist agents, and a real-time monitoring dashboard — packaged as an installable monorepo.

## Why this exists

Claude Code is powerful but opaque at scale. A session that "worked" may have:
- Read only the first 400 lines of an 800-line source file and called it "incorporated"
- Dispatched a subagent with no completeness requirements — and silently passed through its unverifiable output
- Written a "comprehensive synthesis" document with no way to audit which sources were actually read
- Captured no learnings, recommendations, or cleanup items when the session closed

This framework closes those gaps with hooks, rules, agents, and a dashboard — all portable and installable in under a minute.

## What you get

| Component | What it does |
|---|---|
| **10 enforcement patterns** | Guard, Auto-Inject, Audit, Stop Pipeline, Verification Token, Scribe, Atomic Writer, Supervisor Preload, Self-Test, Zero-Path. See [`docs/PATTERNS.md`](docs/PATTERNS.md). |
| **25 hook scripts** | PreToolUse guards, PostToolUse auditors, multi-stage Stop pipeline, SessionStart preloaders. Wired into `~/.claude/settings.json`. |
| **19 specialist agents** | Facilitator, supervisor, source verifier, scribe (multiscope), pdf-extractor, security specialist, and more. |
| **12 workspace rules** | Completion standards, context discipline, read integrity, subagent oversight, work verification, and others — loaded via `CLAUDE.md` hierarchy. |
| **`rh-oversight` CLI** | Install, self-test, health check, settings merge/validate/backup, cross-session supervisor sweep. |
| **Telemetry dashboard** | Real-time monitoring of hook events, enforcement blocks, subagent patterns, and session trends. React + Recharts. |
| **343 tests** | Oversight (177), CLI (54), output (112). Self-test: 37/37 hard pass on every install. |

## Install

```bash
git clone https://github.com/toolbeltross/rh-claude-framework
cd rh-claude-framework
npm install
node packages/cli/bin/rh-oversight.js init --workspace /path/to/your/workspace
```

`init` does:
1. Writes `~/.claude/oversight.json` (workspace + oversight-dir + telemetry port)
2. Copies `rh-*` enforcement scripts → `~/.claude/scripts/`
3. Copies `rh-*` agent definitions → `~/.claude/agents/`
4. Copies `rh-*` skill definitions → `~/.claude/skills/`
5. Copies workspace rules → `<workspace>/.claude/rules/`
6. Merges hooks into `~/.claude/settings.json` (additive — preserves your existing entries by matcher)
7. Writes a starter `<workspace>/CLAUDE.md` if one doesn't exist

Flags: `--dry-run`, `--skip-hooks`.

## Verify

```bash
node packages/cli/bin/rh-oversight.js self-test
# → oversight-self-test: 37/37 hard passed
```

## Quick tour

**An Agent dispatch without oversight requirements gets auto-corrected:**
```
[PreToolUse:Agent] oversight_auto_inject — appending canonical block to prompt
  missing: verification tokens, context report
```
The subagent sees the requirements as part of its own prompt. The parent never had to write them.

**A consolidation document missing a Source Registry gets blocked:**
```
[PreToolUse:Write] consolidation_blocked — MASTER_ANALYSIS.md
  reason: missing Source Registry with verification tokens
```
Claude self-corrects in the same turn by adding the registry.

**At session end, `/rh-quit` drains the session in one LLM pass:**
- Recommendations → `recommendations.md`
- Cleanup items → `cleanup.md`
- Learnings → `~/.claude/memory-shared/learnings/<topic>.md`

Target wall-clock: < 90s for a typical session.

## Packages

| Package | npm name | Purpose |
|---|---|---|
| [`packages/shared`](packages/shared/) | `@rh/shared` | Canonical config + cross-process file lock + env helpers |
| [`packages/oversight`](packages/oversight/) | `rh-claude-oversight` | Enforcement scripts, agents, workspace rules |
| [`packages/output`](packages/output/) | `@rh/output` | Rendered artifacts (HTML dashboards, scribe writers, daily-regen) |
| [`packages/skills`](packages/skills/) | `@rh/skills` | User-invocable skills (`/rh-quit`, `/rh-session`) |
| [`packages/cli`](packages/cli/) | `@rh/cli` | Meta-installer + `rh-oversight` CLI + settings tooling |
| [`packages/telemetry`](packages/telemetry/) | `rh-telemetry` | Real-time monitoring dashboard |

## CLI subcommands

| Command | Purpose |
|---|---|
| `rh-oversight init` | Install / re-deploy framework artifacts |
| `rh-oversight reset` | Reinstall while preserving `oversight.json` |
| `rh-oversight self-test` | Health check — 37/37 hard pass expected |
| `rh-oversight health [--json]` | One-screen aggregator (regen + journals + telemetry + alerts + scribe backlog) |
| `rh-oversight generate-state` | Regenerate `OVERSIGHT_STATE.md` |
| `rh-oversight settings <sub>` | Merge-aware CLI for `settings.json`: `validate / show / diff / merge / backup / restore` |
| `rh-oversight supervisor-sweep [--days N]` | Cross-session trend doc — reads 7-day event window, writes `supervisor-trends.md` |

## Architecture

- **Monorepo** — npm workspaces with 6 packages: `shared`, `oversight`, `output`, `skills`, `cli`, `telemetry`.
- **Zero hardcoded user paths** — all references parameterized through `@rh/shared/config`. Verified via `grep -r "rossb|C:/Users/rossb|OneDrive" packages/` returning no matches.
- **CommonJS** throughout (`require()`); telemetry is the single ESM exception.
- **Config priority**: env var > `~/.claude/oversight.json` > auto-detect (walk up from CWD looking for `.claude/rules/`).
- **Security split**: `rh-security.md` (framework base) + `rh-security-local.md.template` (user's private dirs, gitignored at install time).
- **Cross-process file locking**: `@rh/shared/file-lock` provides atomic O_EXCL lockfiles with PID stamping + 5s stale recovery. Used by all output writers and scribe table writes.
- **Per-turn scribe staging** (on by default): prefilter writes per-turn JSONL to `~/.claude/scribe-staging/`; `/rh-quit` consumes the full staging file instead of the 10K-char transcript tail. Disable with `scribeStaging: false` in `~/.claude/oversight.json` or `RH_SCRIBE_STAGING=0`.

## Development

```bash
# Tests by package
node packages/oversight/tests/run.js   # 177 tests
node packages/cli/tests/run.js         # 54 tests
node packages/output/tests/run.js      # 112 tests (incl. 16-way concurrent stress)

# All workspaces
npm test

# Dry-run install (no filesystem writes)
node packages/cli/bin/rh-oversight.js init --dry-run

# Real install against tmp HOME (outer-seam verification)
HOME=/tmp/test USERPROFILE=/tmp/test \
  node packages/cli/bin/rh-oversight.js init --workspace /tmp/test-ws
```

See [`docs/PATTERNS.md`](docs/PATTERNS.md) for the design rationale behind each enforcement mechanism.
See [`PROGRESS.md`](PROGRESS.md) for current component status and outstanding work.

## License

MIT

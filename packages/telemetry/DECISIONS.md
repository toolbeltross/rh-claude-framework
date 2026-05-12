# Decisions

Decision lineage for this project. Append-only. Newest at top.

---

## 2026-05-06 — Skill installation pipeline: kill the rename-fragility class

### Decision

Re-architected `packages/telemetry/scripts/install-skills.js` so a future rename never breaks `/rh-telemetry` again. Three coordinated changes:

1. **Install path matches slash command**: writes to `~/.claude/skills/rh-telemetry/` (was `telemetry/`). Eliminates the drift between install path and the registered slash-command name that has caused the failure on every rename.
2. **SKILL.md invokes the project CLI via absolute path** — no copy, no symlink. The generated `~/.claude/skills/rh-telemetry/SKILL.md` runs `node "<PROJECT_ROOT>/scripts/telemetry-cli.js"` directly. Replaces the prior copy-then-symlink-server-dir scheme that broke on every rename because `telemetry-cli.js`'s relative `import '../server/config.js'` could never be satisfied at the install location without dragging the entire `server/` tree.
3. **Self-test gate at end of `install-skills.js`** — spawns the installed CLI with `summary` and exits non-zero unless the output matches `/Claude Code Telemetry|No sessions found/`. Any future change that breaks the CLI's import graph fails the installer immediately on the developer's workstation.

Plus a unit-test mirror at `packages/telemetry/tests/unit/install-skills.test.js` (5 tests) so the failure class is also caught in pre-commit.

### Why

Every prior rename (`claude-telemetry` → `rh-claude-code-telemetry` → `rh-telemetry`) left `/rh-telemetry` broken in exactly the same way: a stale chain of symlinks (`~/.claude/skills/rh-telemetry/server` → `node_modules/claude-code-telemetry/server` → `<old-project-name>/server`). The 2026-05-04 rename completion (entry below) updated 12 hook paths in `settings.json` but did not touch the skill install pathway, so the next user invocation of `/rh-telemetry` failed with `ERR_MODULE_NOT_FOUND`. This entry's changes make `node scripts/install-skills.js` from the new project root the single canonical recovery — and the self-test guarantees any regression surfaces at install time, not at user-invocation time weeks later.

### Provenance note — landed in framework, not standalone

The work was first done on the standalone `toolbeltross/rh-telemetry` repo (commit `fe7b7c5` on `main`, local-only). That repo turned out to be archived on GitHub (the migration to `rh-claude-framework/packages/telemetry/` had landed via `chore/migrate-telemetry-to-monorepo` at `f91cc47` but the on-disk copies had drifted apart). The standalone commit is dead-end. This entry records the work as it lives in the framework repo, which is the canonical home going forward.

### Strategic choices made

| Choice | Picked | Alternative considered |
|---|---|---|
| CLI distribution strategy | Absolute path in SKILL.md (no copy, no symlink) | (a) Inline the 5 needed config constants — rejected, creates two sources of truth; (b) Copy `server/config.js` + `start-bg.js` + transitive deps — rejected, `start-bg.js` spawns `server/index.js` from `__dirname/..`, requires copying the entire `server/` tree, brittle; (c) Bundle with esbuild — rejected, adds dep + build step. Absolute path works identically for `npm install -g rh-telemetry` (PROJECT_ROOT = `node_modules/rh-telemetry/`) and workspace dev (PROJECT_ROOT = clone). |
| Install-path naming | `rh-telemetry/` (matches slash command + npm package) | `telemetry/` (legacy). Rejected — the gap between install path and slash command was Defect A in the recurrence pattern. |
| Branch strategy | New `fix/skill-install-rename-resilient` branch off main | (a) Commit on current `fix/result-guard-protocol-compliance` — rejected, mixes unrelated work; (b) commit directly to main — rejected, bypasses repo's per-topic-branch PR pattern. |

### Verification gates passed in this session

- **G1** (outer seam) — `/rh-telemetry` invoked via Skill tool returned live data; SKILL.md "Base directory" header confirmed regenerated file was loaded fresh
- **G2** (outer seam) — `/rh-telemetry live` returned current live session block
- **G3** — `node packages/telemetry/scripts/install-skills.js` printed literal `Self-test passed (CLI is callable end-to-end).`
- **G4** — `node tests/unit/install-skills.test.js` → 5/5 against the framework path
- **G5** — `~/.claude/skills/rh-telemetry/SKILL.md` now references `<framework>/packages/telemetry/scripts/telemetry-cli.js`, not the standalone path

### Source

- Plan file: `C:/Users/user/.claude/plans/check-with-the-supervisor-sparkling-meteor.md`
- Standalone-repo mirror commit (dead-end): `toolbeltross/rh-telemetry@fe7b7c5` (local-only, repo archived)
- This commit's branch: `fix/skill-install-rename-resilient` off `main` at `89966c0`

---

## 2026-05-04 — Rename completion (directory + GitHub repo)

### Decision

Finished the rename queued from 2026-05-03. All four artifacts that still carried the old name are flipped:

- **Workspace directory** — `rh-claude-code-telemetry/` → `rh-telemetry/` on disk
- **GitHub repo** — `toolbeltross/rh-claude-code-telemetry` → `toolbeltross/rh-telemetry` (auto-redirect preserves old URL)
- **`~/.claude/settings.json`** — 12 hook-command paths repointed to `rh-telemetry/scripts/...`
- **`team-ai-tools` push** — submodule-removal commit `234f28c` pushed to `toolbeltwork/team-ai-tools` toolbeltross branch

Plus auto-generated docs refreshed: `ENVIRONMENT.md`, `OVERSIGHT_STATE.md`, and the three workspace HTML renders (env, state, system) via `rh-daily-regen.js`. `package-lock.json` regenerated to pick up the renamed package name.

### Lock-holder diagnosis

Yesterday's session bailed on the directory rename due to "Device or resource busy" on `scripts/`. This session identified the holder via the Windows Restart Manager API (`rstrtmgr.dll RmGetList`) registered against files in `scripts/`: PID 1948 — an orphan `desktop-commander` MCP node process from a yesterday session. Killing that one cleared file-level locks but the directory-level lock (CWD-style, not file-content) persisted because 15 other orphan `desktop-commander` processes remained. A reboot cleared all of them; the rename succeeded immediately on session restart.

### Sequencing

- A. Backed up settings.json → `settings.json.pre-dir-rename-20260504`
- A. Created a temporary `rh-telemetry → rh-claude-code-telemetry` directory junction (NOT a symlink — junctions don't need admin/Developer Mode on Win11) so hooks kept resolving while settings.json was edited
- A. Edited settings.json (12-occurrence replace_all of the substring)
- A. Removed the junction once settings.json was flipped
- B. Reboot, then `mv rh-claude-code-telemetry rh-telemetry` (succeeded)
- B. Re-ran `rh-oversight-self-test.js` → 37/37 hard pass + 1 soft warning (doc-sync, expected mid-flight); `npm test` → 25/25 files pass
- B. Manually started telemetry server via new path (`start-bg.js`) → `/api/health` 200 OK
- C. `gh repo rename` (uses existing `repo` scope, did NOT need `delete_repo`); `git remote set-url`; `git fetch --dry-run` clean
- D. Located `team-ai-tools` at `…/toolbeltross/toolbeltwork/team-ai-tools/` (not `toolbeltwork/` as inventory hint suggested); pushed `8a64880..234f28c`
- E. Final sweep → 21 remaining hits in workspace, all historical narrative / immutable browser snapshots / archived plans / separate-project (rh-claude-framework) references; none are broken active paths

### Carried forward

- **Delete `toolbeltross/claude-telemetry` (the obsolete second repo)** — ✅ done 2026-05-04. User completed `gh auth refresh -h github.com -s delete_repo` OAuth; `gh repo delete toolbeltross/claude-telemetry --yes` succeeded; `gh repo view` returns 404.
- **`toolbeltross/claude-telemetry-archived`** — moved to local Archive (`Workspace/Archive/claude-telemetry-archived/`) preserving full git history (commit `285878c`); GitHub repo deleted afterward.
- **Framework migration** (`rh-telemetry/` → `rh-claude-framework/packages/telemetry/`) — ✅ done 2026-05-04 via PR #3. D-α copy strategy (zero loss base + reapplied `lib/config` abstraction). Live `:7890` server cut over from old workspace clone to migrated location. Old `toolbeltross/rh-telemetry` GitHub repo archived (read-only). This file you're reading now is the migrated DECISIONS.md.
- **OVERSIGHT_SYSTEM.md design-doc sync** — ✅ done 2026-05-04. Appended "2026-05-04 (later)" + "2026-05-04 (final)" bullets under Rename history. Re-ran `rh-daily-regen.js` (9/9 ok) and `rh-oversight-self-test.js` — `doc-sync probe` now PASS, 37/37 hard, 0 soft warnings.

### Source

- Plan file: `C:/Users/user/.claude/plans/recursive-pondering-alpaca.md`
- Backup: `~/.claude/settings.json.pre-dir-rename-20260504`

---

## 2026-05-03 — Rename `rh-claude-code-telemetry` → `rh-telemetry`

### Decision

Canonical name across all surfaces is `rh-telemetry`:

- npm package name: `rh-telemetry` (was `rh-claude-code-telemetry`)
- CLI bin: `rh-telemetry` (already)
- env vars: `RH_TELEMETRY_*` (was `CLAUDE_TELEMETRY_*`) — hard rename, no fallback alias
- GitHub repo: `toolbeltross/rh-telemetry` (queued; needs `gh auth refresh -s delete_repo` then GitHub UI rename)
- workspace directory: `toolbeltross-public/rh-telemetry/` (queued; blocked this session by a stubborn `scripts/` lock — needs Claude Code restart to clear)
- references in `~/.claude/`, `~/.claude/memory-shared/`, `Workspace/.claude/`, `claude-setup-ross/oversight-system/` — all updated

### Why

User directive: "I would like to call it rh-telemetry everywhere including package names, variables, anywhere, hooks, infrastructure." The accumulated names (`claude-telemetry` → `rh-claude-code-telemetry` → `rh-telemetry`) had created cognitive overhead across hooks, docs, and memory; one canonical name eliminates the surface area for confusion.

### Strategic choices made

| Choice | Picked | Alternative considered |
|---|---|---|
| Env var transition | Hard rename (no `RH_TELEMETRY_X || CLAUDE_TELEMETRY_X` fallback) | Fallback chain for one release. Rejected because pre-publication = no external consumers to alias. |
| Bridge timing | Rename FIRST, framework migration (`rh-claude-framework/packages/telemetry/`) AFTER | Forward-port drifted scripts then rename. Rejected per supervisor: doubles outer-seam verification surface; better to keep rename atomic against known-working baseline. |
| Old `toolbeltwork/.../claude-telemetry/` submodule | Deleted (with replacement-assessment in commit message) | Leave with STALE.md marker. Rejected because stale copy was already misleading prior sessions per the two-copy mental model in `project_hook_perf_and_turn_viz.md`. |
| Old GitHub repo `toolbeltross/claude-telemetry` | Deletion authorized after content verification — separate commit history (HEAD `159808477...` not in successor), full prior incarnation of the dashboard, abandoned 2026-04-09. Delete itself queued behind auth-scope refresh. | Archive on GitHub. Rejected after user confirmed superseded contents. |

### Verification gates passed in this session

- `node ~/.claude/scripts/rh-oversight-self-test.js` → 37/37 (baseline preserved)
- `npm test` → 25/25 files passed (unit + integration; tool-validator-v2 44/44, subagent-orphan 5/5)
- Telemetry server boots clean on port 7890 with `RH_TELEMETRY_PORT` env (default still 7890)
- Hook firing live: `hook-debug.log` records this session's events end-to-end
- Project grep audit: 0 remaining `CLAUDE_TELEMETRY*` / `claude-telemetry` / `rh-claude-code-telemetry` in source files (excl `.git/`, `.playwright-mcp/`, `dist/`, `*.log`)
- Workspace + `~/.claude/` grep audit: only historical-stamp slugs (`consolidated_from:`, `migrated-from:` frontmatter) and intentional rename-history prose remain

### Followups (deferred from this session)

1. **Directory rename** `rh-claude-code-telemetry/` → `rh-telemetry/` blocked by an opaque lock on `scripts/` (no identifiable process holder). Likely a watcher in this Claude Code session. Resolution: restart Claude Code, retry rename.
2. **Final settings.json hook paths** — the 12 hook commands need their `rh-claude-code-telemetry/` segment swapped to `rh-telemetry/` after the directory rename. Pre-pre-rename backup at `~/.claude/settings.json.pre-rh-telemetry-rename-20260503-154230`.
3. **GitHub repo rename** — needs `gh auth refresh -h github.com -s delete_repo` then UI rename + local `.git/config` remote URL update.
4. **GitHub repo delete** for `toolbeltross/claude-telemetry` — same auth-scope refresh.
5. **`team-ai-tools` push** — submodule-removal commit `234f28c` on `toolbeltross` branch is local; user pushes manually.
6. **Framework migration** — move `rh-telemetry/` into `rh-claude-framework/packages/telemetry/` and forward-port the 14 drifted + 3 deployed-only `rh-*` scripts from `~/.claude/scripts/` into `rh-claude-framework/packages/oversight/scripts/`. Tracked in `rh-claude-framework/PROGRESS.md` item #5.

### Source

- Plan file: `C:/Users/user/.claude/plans/do-the-analysis-and-expressive-liskov.md`
- Session ID: 53e2eec0
- Supervisor scope review: returned with bridge-timing flip + 6 scope-addition findings (env-var blast radius, gist statusline alias risk, settings.json backup, self-test:292 stale path, statusline comment markers, EBUSY-on-OneDrive caveat — last item moot since OneDrive sync is off).

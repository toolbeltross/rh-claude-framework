# Distribution Readiness Plan

Status: PRE-PUBLISH GATE — Phases 1, 2, 3, 4.3 ✅ DONE 2026-05-06 (verified against current monorepo state). Phase 4.1 (git ownership decision) and Phase 5 (npm publish) remain user-gated.

## Status check (2026-05-06)

| Phase | Item | Current state |
|---|---|---|
| 1.1 | Remove `docs/` from npm `files` | ✅ Done — `files: ["bin/", "server/", "scripts/*.js", "dist/"]` |
| 1.2 | Remove `src/` from npm `files` | ✅ Done — same |
| 1.3 | Remove `['Ross Here', 'rossb']` profiles in `setup-hooks.js` | ✅ Done — grep returns zero matches |
| 1.4 | Add LICENSE | ✅ Done — `packages/telemetry/LICENSE` exists |
| 1.5 | Move/remove `cross-env` | ✅ Done — `cross-env` not in package.json |
| 2.1 | Delete 5 obsolete scripts | ✅ Done (4/5 already gone via prior cleanup; 1 kept: `supervisory-agent-prompt.md` is still the active reference doc for Layer 3a per `CLAUDE.md:235` — re-enabled 2026-04-19 after the plan was written) |
| 2.2 | Clean up `filterOurEntries` strings | ✅ Done — only `'ADDITIVE ONLY'` remains and it's the LIVE Layer 3a marker (load-bearing for hook detection during reinstall) |
| 3.1 | README accuracy fixes | ✅ Done 2026-05-06 — clone URL updated to framework, slash commands renamed `/telemetry` → `/rh-telemetry`, hook count and Stop description already current |
| 3.2 | Privacy section | ✅ Done — README lines 178-183 |
| 4.1 | Git ownership (Ross Here vs rossb) | ⏳ User decision — not actionable in-session |
| 4.2 | Verify git remote matches package.json | ✅ Done — `repository.url: https://github.com/toolbeltross/rh-claude-framework`, `directory: packages/telemetry` |
| 4.3 | `.npmignore` defense-in-depth | ✅ Done — `.npmignore` exists |
| 5 | `npm pack` + `npm publish` | ⏳ User-gated, irreversible (72h unpublish window) |

**Net pending for npm publish:** make 4.1 ownership decision (or skip via `safe.directory`), then run Phase 5.

---

## Open Question (original — preserved for context)

Both `rossb` and `Ross Here` are the same person. The repo is currently owned by Ross Here.
Decision needed: which user should own the files going forward?
- **Ross Here (admin)**: owns the repo now, avoids dubious ownership when committing
- **rossb**: daily driver account, runs Claude Code sessions
- Consider: git safe.directory may be simpler than chown-ing everything

---

## Phase 1: Remove Personal Content from Package (BLOCKERS)

### 1.1 Remove `docs/` from npm `files` field
- [ ] Edit `package.json`: remove `"docs/"` from the `"files"` array
- [ ] Verify: `npm pack --dry-run` should no longer list any `docs/*` files
- **Why**: `docs/user-requirements.md` contains verbatim personal messages with profanity, `docs/setup-ross-here.md` has personal usernames/ports. (Note: `docs/supervisory-log.md` previously held session telemetry data; it has since moved out of the repo to `~/.claude/telemetry-supervisory-log.md`.)

### 1.2 Remove `src/` from npm `files` field
- [ ] Edit `package.json`: remove `"src/"` from the `"files"` array
- [ ] Verify: `npm pack --dry-run` should no longer list `src/*` files
- **Why**: `dist/` is the built frontend served by the server. `src/` is only for contributors who clone from git. Saves ~150KB in the published package.

### 1.3 Remove hardcoded user profiles from `setup-hooks.js`
- [ ] Edit `scripts/setup-hooks.js` lines ~89-98: remove the `['Ross Here', 'rossb']` logic
- [ ] Replace `getTargetPaths()` with single-user logic: always write to `homedir()/.claude/settings.json`
- [ ] Remove the `--target` CLI flag and `TARGET` variable (lines ~23-25)
- [ ] Update the console output that references `--target all` (lines ~236-238, ~286-287)
- [ ] Verify: `node scripts/setup-hooks.js --dry-run` writes only to current user's settings
- **Why**: multi-profile logic is personal to this machine. Other users have one profile.

### 1.4 Add LICENSE file
- [ ] Create `LICENSE` in project root with MIT license text
- [ ] Use author: "Ross Beveridge" (or preferred name) and year 2026
- [ ] Verify: `npm pack --dry-run` includes LICENSE

### 1.5 Move `cross-env` to devDependencies
- [ ] Run: `npm install cross-env --save-dev` (moves it from dependencies to devDependencies)
- [ ] Or: remove it entirely and fix the `start` script to not use `NODE_ENV=production` prefix
- [ ] Simpler fix: change `"start"` script to just `"node server/index.js"` and drop cross-env
- **Why**: every user who installs the package downloads cross-env but it's only used by one npm script

---

## Phase 2: Clean Up Dead Files (SHOULD FIX)

### 2.1 Remove obsolete scripts from repo
These files are superseded and no longer imported or referenced by active code:
- [ ] `scripts/tool-validator.js` (v1 — replaced by `tool-validator-v2.js`)
- [ ] `scripts/statusline.js` (replaced by `hook-forwarder.js status` mode)
- [ ] `scripts/progress-tracker.js` (absorbed into `hook-forwarder.js stop` mode)
- [ ] `scripts/supervisory-agent-prompt.md` (reference doc, agent hooks removed)
- [ ] `scripts/supervisory-agent-prompt-v2.md` (reference doc, agent hooks removed)
- [ ] Before deleting, grep the codebase to confirm nothing imports them:
  ```bash
  grep -r "tool-validator\.js\|statusline\.js\|progress-tracker\.js\|supervisory-agent-prompt" --include="*.js" --include="*.json" .
  ```
- **Why**: confuses contributors, adds ~24KB dead weight to the npm package

### 2.2 Clean up filter function in setup-hooks.js
- [ ] In `filterOurEntries()`, remove references to deleted prompt strings that no longer exist:
  - `'Anthropic Expert Supervisory'`
  - `'dedicated tool handles better'`
  - `'ADDITIVE ONLY'`
  - `'supervisory quality gate'`
  - `'Subagent did not complete'`
- [ ] Keep `h.type === 'agent'` (strips any leftover agent hooks from existing installs)
- **Why**: dead code that references removed features

---

## Phase 3: Update README (BLOCKER)

### 3.1 Fix inaccurate content
- [ ] Line 13: change "3-layer validation system (deterministic + LLM + deep review)" to "deterministic tool-usage validation" (agent hooks removed)
- [ ] Line 29: change `github.com/rossb/` to match actual repo URL in package.json (`github.com/toolbeltross/`)
- [ ] Line 44: change "10 Claude Code hooks" to "11 Claude Code hooks"
- [ ] Line 48: change "Stop — marks turn boundaries + runs supervisory agent review" to "Stop — marks turn boundaries"
- [ ] Add ConfigChange and TaskCompleted to the hook list in "What `setup` Does"
- [ ] Verify repo URL in package.json is the one you'll actually publish to

### 3.2 Add credential disclosure
- [ ] Add a section (e.g., under Architecture or a new "Privacy" section):
  ```
  ## Privacy

  The dashboard reads `~/.claude.json` and `~/.claude/stats-cache.json` for session data.
  For Max plan usage detection, it reads OAuth credentials from `~/.claude/.credentials.json`
  (or macOS Keychain). Credentials are used locally to check plan limits — they are never
  transmitted anywhere except Anthropic's API. All data stays on your machine.
  ```

---

## Phase 4: Git Repo Setup (SHOULD FIX)

### 4.1 Fix dubious ownership
- [ ] As Ross Here (admin), decide: keep Ross Here as owner, or chown to rossb
- [ ] If keeping Ross Here: rossb needs `git config --global --add safe.directory C:/Users/rossb/OneDrive/Workspace/Code/rh-telemetry`
- [ ] If transferring to rossb: `icacls` or `takeown` on the repo directory

### 4.2 Verify git remote
- [ ] Confirm remote origin matches the repo URL in package.json
- [ ] Create the GitHub repo if it doesn't exist yet: `gh repo create toolbeltross/rh-telemetry --public`

### 4.3 Add .npmignore as defense-in-depth
- [ ] Create `.npmignore`:
  ```
  CLAUDE.md
  _index.md
  docs/
  src/
  tests/
  .claude/
  .vite/
  hook-debug.log
  *.tgz
  PLAN-*.md
  ```
- **Why**: `files` allowlist works, but `.npmignore` prevents accidents if new files are added to allowed directories

---

## Phase 5: Pre-Publish Verification

### 5.1 Build and test
- [ ] `npm run build` — verify dist/ is generated
- [ ] `npm pack --dry-run` — review final file list, confirm no personal content
- [ ] `npm pack` — create tarball, extract it, inspect contents manually
- [ ] Test fresh install: `npm install -g ./rh-telemetry-1.0.0.tgz`
- [ ] `rh-telemetry setup --dry-run` — verify hooks look correct
- [ ] `rh-telemetry start` — verify server starts and serves dashboard
- [ ] `rh-telemetry status` — verify health check works

### 5.2 Publish
- [ ] `npm login` (if not already)
- [ ] `npm publish` — publishes to npm registry
- [ ] Verify: `npm info rh-telemetry`
- [ ] Test: `npm install -g rh-telemetry` from a clean environment

---

## Files Modified (Summary)

| File | Action |
|------|--------|
| `package.json` | Remove `docs/` and `src/` from `files`, move `cross-env` to devDep or remove |
| `scripts/setup-hooks.js` | Remove hardcoded profiles, `--target` flag |
| `README.md` | Fix inaccuracies, add privacy section |
| `LICENSE` | Create (MIT) |
| `.npmignore` | Create |
| `scripts/tool-validator.js` | Delete |
| `scripts/statusline.js` | Delete |
| `scripts/progress-tracker.js` | Delete |
| `scripts/supervisory-agent-prompt.md` | Delete |
| `scripts/supervisory-agent-prompt-v2.md` | Delete |

## Notes

- CLAUDE.md is NOT modified — it stays as internal documentation (not shipped to npm, but visible on GitHub)
- `docs/` stays in git for contributor reference — just excluded from the npm package
- The `setup-hooks.js` filter function keeps `h.type === 'agent'` to clean up agent hooks from existing user installs
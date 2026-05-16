# Session Handoff — 2026-04-19 (PC restart in progress)

Context for picking up after restart. Last session worked through (a) consolidating the project's plan files, (b) starting the npm-publish prep, (c) diagnosing and fixing the supervisory-log drift, (d) answering a narrow audit from a parallel main session.

---

## Outer-seam verification status (critical)

The dual-write for the supervisory log is **now outer-seam verified**. Seven paired entries exist in both `~/.claude/telemetry-supervisory-log.md` and `<oversight-workspace>/oversight-system/supervisory-log.md`, produced by real Claude Code Stop hooks between 07:48:50 and 08:02:15 on 2026-04-19. The `oversight=on` flag fires in `hook-debug.log` for each. No manual intervention required for this to continue — the env block in `~/.claude/settings.json` is persistent and is inherited by every Claude Code session from now on.

PreCompact hook remains **unverified outer-seam** — Claude Code has never fired it in this environment (0 occurrences in hook-debug.log across all history, while all other configured hooks fire fine). Server-side `/api/compact` ingestion works (verified via manual POST); the gap is Claude Code's side. See Outstanding § PreCompact investigation below.

---

## What landed (committed in `rh-telemetry`)

Two commits on `master`, pre-commit unit suite (8/8) passed on both:

- `61587f5 Consolidate retired plans into docs/PLAN.md + npm prep`
- `f1cc250 Dual-write supervisory log to optional OVERSIGHT_LOG_PATH`

`master` is **20 commits ahead of `origin/master`** (16 pre-session + 2 from today + possibly more from the Layer 3a work in the parallel session). Not pushed — deliberate, awaiting user.

## What's on disk but NOT committed (`<oversight-workspace>` — not a git repo)

All saved, none versioned:

- `oversight-system/supervisory-log.md` — gap header (2026-04-06→2026-04-18), 303-entry back-fill under "## Back-filled from telemetry log", new "## Session Progress (dual-write resumed)" marker, plus live entries from today's real Stop hooks
- `oversight-system/incidents/2026-04-15-supervisory-log-drift.md` — status flipped `diagnosed` → `fixed`, root cause rewritten (path swap, not snapshot endpoint)
- `LOOSE_ENDS_2026-04-15.md` — LE-13 flipped to `✅ RESOLVED`, new LE-16 added for cross-subagent dispatch-prompt correlation (deferred)

To version-control: `cd <oversight-workspace> && git init && git add . && git commit -m "Initial snapshot with 2026-04-18 oversight fixes"` — your call.

## What's persistent for next session

- `~/.claude/settings.json` env block: `OVERSIGHT_LOG_PATH=C:/Users/<user>/<workspace-root>/<oversight-workspace>/oversight-system/supervisory-log.md` — inherited by all future Claude Code sessions, no setx required
- `rh-telemetry-1.0.0.tgz` at telemetry repo root — pack artifact, can be deleted or kept (not tracked by git, not shipped by npm publish either)
- `.claude/worktrees/bold-driscoll/` — untracked worktree with its own branch (`claude/bold-driscoll`), abandoned content, decision pending

---

## Outstanding items, roughly ordered by when you'd pick them up

### 1. `docs/PLAN.md` Thread 1.3 — npm publish (blocked on login)

- `npm whoami` → ENEEDAUTH. `npm view rh-telemetry` → 404 (name available)
- Next steps: `npm login` interactively, `npm publish`, verify, smoke-test global install
- Tarball already built and inspected — 36 files, 270.7 kB, no leaks

### 2. `docs/PLAN.md` Thread 2 — OTel enrichment (~3.5h, parked)

Optional. Specifies: minimal OTLP/HTTP receiver + MCP attribution panel + skill pill strip. Only pursue if dogfooding shows the enrichment data is worth surfacing.

### 3. PreCompact investigation (raised at end of last session)

- 0 `mode=compact` entries in `hook-debug.log` across all history — Claude Code isn't invoking the hook
- All other configured hooks fire fine, same matcher-less shape
- Manual POST to `/api/compact` works (server-side OK)
- Open: (a) fetch `code.claude.com/docs/en/hooks` to confirm PreCompact trigger conditions (does `/compact` slash vs auto-compact matter?) + check both sessions' `claude --version`
- Optional fallback: context-history compaction detector in `store.js` (large downward step in context usage is reliable compaction signature, independent of the hook)

### 4. Supervisor finding — process lesson (do not lose this)

The Layer 3a Stop-hook supervisor caught a real Rule-1 violation earlier this session: I claimed "dual-write live and verified end-to-end" when I'd only run inner-unit tests (`node hook-forwarder.js stop` with canned stdin). Outer-seam verification (real Stop hook inheriting env from settings.json) came later, by luck. For future completion claims: **do not use "verified" / "live" / "tested end-to-end" until the outer seam has been observed firing, not just the inner unit**. Gap-list until then.

### 5. Tracker items (pre-existing, not in today's scope)

- **LE-07** — Layer 3 supervisor agent broader implementation; original 278-line plan archived at `oversight-system/archive/plan-layer3-supervisory.md`. Layer 3a already shipped (narrow 3-rule prompt-hook variant — see oversight log's 2026-04-19 section); Layer 3b agent-hook variant parked to avoid double per-turn cost. Status tracked in `<oversight-workspace>/LOOSE_ENDS_2026-04-19.md`
- **LE-08** — explicitly kept open per earlier instruction from the parallel session; do not close
- **LE-14** — Obsidian visibility filters (`*.html`, `.claude/`)
- **LE-15** — wiki wikilink normalization
- **LE-16** — cross-subagent dispatch-prompt correlation (design note; do not implement)

### 6. Quality improvements (nice-to-haves)

- **Dual-write symmetry** — primary `SUPERVISORY_LOG_PATH` write has ENOENT auto-create w/ header seeding; secondary `OVERSIGHT_LOG_PATH` write doesn't. ~5 lines to mirror. See `scripts/hook-forwarder.js:96–117`
- **Unit test for dual-write branch** — nothing permanent landed in `tests/`. Would slot cleanly into existing Phase A test-harness style
- **Worktree cleanup** — `.claude/worktrees/bold-driscoll/` had uncommitted edits to `.claude/agents/visual-parity.md` + `launch.json` and its own `tool-validator-issues.md`. Decide prune or integrate

---

## Things that will be wiped / reset by the restart

- **Telemetry server process + in-memory state** — `SessionStart` hook auto-restarts it via `scripts/start-bg.js`. Live sessions table resets; no action needed
- **Synthetic compact event** I posted to session `5318d2af` during PreCompact diagnostics — purged on server restart (wasn't persisted)
- **This conversation's context** — captured here; pick up from this file
- **npm login state** — still not logged in; you'll need to `npm login` when you resume Thread 1.3

## Things that will survive the restart

- All source edits (two new commits + the handoff file you're reading)
- `~/.claude/settings.json` env block — will be inherited by new Claude Code immediately
- `hook-debug.log` — all hook fires including the outer-seam verification evidence
- Both supervisory logs with their paired entries
- `telemetry-failures.jsonl`
- Uncommitted changes in `<oversight-workspace>` (they're on disk, just not in a repo)

---

## First action on pick-up

1. `/session` to confirm environment healthy
2. Verify outer-seam still works: after your first turn ends in the new Claude Code session, `tail -2` both supervisory logs and confirm the new entry appears in both
3. Decide: push the 20 telemetry commits? init the <oversight-workspace> repo? `npm publish`?
4. If resuming work on this project, open `docs/PLAN.md` as the canonical task list

No hidden state. No secrets. Nothing waiting on me.

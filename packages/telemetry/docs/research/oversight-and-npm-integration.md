# Phase 0.6 — Oversight + npm Plug-in Integration Audit

> Research output from subagent dispatch, 2026-05-20. Source registry at bottom.

## Section 1 — Oversight signals × v1 coverage × v2 home

### Bridge inventory (current package)

| Bridge file | Data in | WS broadcast | v1 component |
|---|---|---|---|
| `server/trends-router.js` (77 lines) | `~/.claude/oversight-events.jsonl` via cross-package `createRequire(rh-supervisor-sweep)` + `~/.claude/oversight/supervisory-log.md` Layer3a rejections | None (pure HTTP `GET /api/trends?days=N`) | `src/components/TrendsTab.jsx` |
| `server/hook-receiver.js` (301 lines) | POSTs from `hook-forwarder.js`: tool events, status, turn-end, compact, subagent, prompt, config-change, task-completed, hook-perf | All routed through `store` → WS | `ToolActivity`, `FailureHistory`, `CurrentPrompt`, `AgentActivity`, `SubagentTracker/Timeline`, `TurnTracker`, `TurnHeartbeat` |
| `server/failure-store.js` (275 lines) | Appends to `~/.claude/telemetry-failures.jsonl` with errorClass / invocationHash / retrySequence / promptId / estimatedCost | `failureEvent` via `onAppend` | `FailureHistory.jsx` |
| `server/hook-perf-store.js` (123 lines) | Reads `~/.claude/hook-perf.jsonl` (canonical writer is `lib/hook-timing.js` inside oversight package; server is read-only since 2026-05-08) | Via `onAppend` on POST `/api/hook-perf` | No dedicated v1 component — only `scripts/hook-perf-cli.js` |
| `server/hook-health.js` (141 lines) | Tail of `<telemetry-pkg>/hook-debug.log` (error-line scan + transcript-parse p95 regex) | None — pull via `GET /api/hook-health` | No dedicated v1 component (planned chip) |
| `server/statusline-watcher.js` (68 lines) | `chokidar` on `~/.claude/settings.json`; reclassifies statusLine | `STATUSLINE_STATE` via `updateStatusLineState` | `StatusLineBanner.jsx` |

### Oversight events feed — `~/.claude/oversight-events.jsonl`

2,266 lines (~700 KB). **6 distinct `event_type` values:**

| Event type | Count | v1 surface | Notes |
|---|---|---|---|
| `instructions_loaded` | 1,726 | TrendsTab (aggregated only) | Dominant noise — 76% of feed; many `source_count:0` heartbeats |
| `oversight_auto_inject` | 309 | TrendsTab (aggregated only) | Auto-injected oversight block warnings (missing `verificationToken`/`contextReport`/`batchOverflow`) |
| `daily_regen_stale_alert` | 182 | TrendsTab (aggregated only) | OVERSIGHT_STATE.md regen has not run today |
| `subagent_orphan_alert` | 49 | TrendsTab (aggregated only) | SubagentStop fired without matching SubagentStart |
| `subagent_protocol_violation` | 1 | TrendsTab (aggregated only) | Rare — guard catches actual protocol breach |
| `journal_staleness_alert` | 1 | TrendsTab (aggregated only) | Journal not updated within configured window |

All 6 types reach v1 **only** via TrendsTab's 7/14/30/N-day aggregation — there is no real-time "an oversight event just fired" surface anywhere. The live feed is invisible.

### Scribe outputs (visible to dashboard only if exposed)

- `~/.claude/memory-shared/learnings/` — **85 files** (84 `.md` topics + `MEMORY.md` index). NOT surfaced in v1.
- `recommendations.md` / `cleanup.md` — **5 instances** across workspace:
  - Workspace root: `<workspace>/{recommendations,cleanup}.md` (351 + 342 lines — active scribe targets)
  - Per-project: `rh-claude-framework/` (15 + 14 lines), `rh-platform-agentbuild/`, `expdate-extractor/`
  - NOT surfaced in v1
- `~/.claude/oversight/supervisory-log.md` — Layer 3a rejections; aggregated counts shown in Trends but no per-rejection viewer
- `<oversight-dir>/OVERSIGHT_STATE.md` + `OVERSIGHT_SYSTEM.md` — auto-regen state + hand-authored design doc. NOT surfaced

### Recommendations table — signal × proposed v2 home

| Signal source | Event types / fields | v1 surface | Proposed v2 surface | Rationale |
|---|---|---|---|---|
| `oversight-events.jsonl` live tail | All 6 types | NONE (live) | **Live tab** sidebar feed + **Oversight tab** filterable list | Real-time visibility into oversight infra is the missing piece — supervisor-sweep is post-hoc only |
| `oversight_auto_inject` per-session | `missing_elements`, `subagent_type`, `description` | TrendsTab aggregate | **Oversight tab** + per-session drill (Session detail) | Session-scoped attribution turns aggregate "309 injects" into "this session had 4 — which agents?" |
| `subagent_orphan_alert` | `agent_id`, `transcript_status` | TrendsTab aggregate | **Failures tab** (extend) + Oversight tab | Orphans are a failure class; FailureHistory already groups orphans (`errorClass='orphan'`) but oversight-event orphans don't flow there |
| `daily_regen_stale_alert` | `last_run`, `oversightDir` | TrendsTab aggregate | **Settings/Health** chip (StatusLineBanner-style strip) | Persistent infra health — banner, not feed |
| `supervisory-log.md` Layer3a rejections | Rejection reasons / time | TrendsTab top patterns | **Oversight tab** — clickable list | Aggregated only today; rejection viewer would let user see *why* Stop hook fired |
| `hook-perf.jsonl` per-hook stats | p50/p95/max per hook | CLI only | **Settings → Health** panel + **History tab** mini-chart | Already aggregated server-side; just needs UI binding |
| `hook-debug.log` tail | errorCount, transcriptP95Ms | Endpoint only | **StatusLineBanner area** chip ("hooks ok / failing") | Endpoint exists; v1 never bound it |
| `telemetry-failures.jsonl` | Already wired | FailureHistory | **Failures tab** (keep) + add cost-weighted ranking from `/api/failures/top-cost` | D4 endpoint exists but not surfaced |
| Scribe `recommendations.md` / `cleanup.md` (workspace + per-project) | File contents | NONE | **Oversight tab → Recommendations sub-panel** (read-only viewer, source-path tabs) | User cited oversight integration; scribe is the visible output of that infra |
| `~/.claude/memory-shared/learnings/` | 85 topic files | NONE | **History tab → Learnings browser** (read-only) | Capability deltas accrue silently; browse-and-search surface unlocks recall |
| OVERSIGHT_STATE.md / OVERSIGHT_SYSTEM.md | Rules / hooks / agents inventory | NONE | **Settings tab → Oversight Inventory** (read-only markdown render) | Mirrors `/session` skill |
| `statusLine` classifier | `class`, `reason` | StatusLineBanner | Keep banner in v2 header; also expose in Settings | No change |

### Bridge pattern recommendation

The `createRequire` ESM→CJS bridge in `trends-router.js` is fine for **read-only aggregation modules** but should not be replicated for every cross-package data flow. Three v2-time tightenings:

1. **Workspace import for new modules** — the monorepo has `@rh/shared`, `@rh/output`, `@rh/oversight` namespace conventions. New cross-package CJS modules during v2 should be authored to be importable via the workspace name, with `createRequire` reserved for cases like `rh-supervisor-sweep` where consumer is ESM and producer is CJS and dual-publishing isn't justified.
2. **Stable façade module** — wrap `createRequire(SWEEP_PATH)` in a thin `server/oversight-bridge.js` that exports `{ readEvents, aggregate, readLayer3aRejections }` so multiple v2 routers can import it without each duplicating `SWEEP_PATH` resolution.
3. **Push a "new oversight event" WS frame** — TrendsTab is currently poll-only. For Live/Oversight tabs to feel real-time, add a chokidar watcher on `~/.claude/oversight-events.jsonl` (mirroring `statusline-watcher.js`) that emits a WS `OVERSIGHT_EVENT` frame on append.

### Scribe surfaces recommendation

Treat scribe outputs as **read-only viewable artifacts**, not editable. v2 should expose them via a Recommendations sub-panel inside an Oversight tab with source-file tabs (workspace, current project, learnings index). No write path — scribe drains run via `/rh-quit`; dashboard only displays. This keeps scribe authorship in the agent layer and visibility in the dashboard layer, matching the user's "oversight integration" framing.

## Section 2 — npm shipping options

### Current `files` + tarball

`package.json` `files` field: `["bin/", "server/", "scripts/*.js", "dist/"]`. `bin: rh-telemetry → bin/rh-telemetry.js`. `main` not set. `prepublishOnly: npm run build`.

**Tarball: 312.2 KB packed / 1.1 MB unpacked, 41 files.** Heaviest entries:
- `dist/assets/index-wViFJixm.js` — 769.7 KB (Vite-bundled v1 frontend)
- `dist/assets/index-DNHDGleC.css` — 37.5 KB
- `scripts/hook-forwarder.js` — 36.4 KB
- `server/store.js` — 40.6 KB
- `scripts/telemetry-cli.js` — 19.4 KB
- `scripts/setup-hooks.js` — 15.5 KB
- `scripts/repair-statusline.js` — 13.3 KB
- `README.md` — 13.2 KB

Source dirs: `src/` 398 KB, `server/` 144 KB, `scripts/` 217 KB, `dist/` 807 KB. `src/` is correctly excluded.

### CLI / installer UI-awareness audit

Subcommands in `bin/rh-telemetry.js`:

| Command | UI-aware? | Notes |
|---|---|---|
| `setup` | No | Runs setup-hooks + install-skills + install-git-hooks — all infra |
| `start` / `start --bg` | **Yes (implicitly)** | Serves whatever `dist/` was built — would need `--ui v1|v2` or env var to pick which build |
| `dev` | **Yes (implicitly)** | Runs `npx vite` — Vite config currently only knows v1 entry point |
| `status` | No | Health check |
| `digest`, `summary`, `sessions`, `costs`, `context`, `activity`, `live`, `session`, `hook-perf` | No | Pure CLI output |
| `repair-statusline`, `install-git-hooks` | No | Infra |

`scripts/install-skills.js` writes `~/.claude/skills/rh-telemetry/SKILL.md` referencing `PROJECT_ROOT/scripts/telemetry-cli.js` via absolute path. **No UI assumptions** — skill is CLI-only. Self-test only checks CLI invocation. Skills do not need UI awareness.

`scripts/setup-hooks.js` writes hook configs that POST to `:7890`. Server-port-aware, not UI-aware.

**v2-time CLI work needed:**
- `start` and `dev` need `--ui v1|v2` (or `RH_TELEMETRY_UI` env var read at server startup) to pick which `dist/` to serve. Server's static-file root needs to become dynamic.
- A second `dist-v2/` build artifact, or a single `dist/` with `dist/v1/` and `dist/v2/` subpaths chosen at request time.

### Packaging tradeoff table

| Option | Pros | Cons | Tarball delta |
|---|---|---|---|
| **(a) v2 inside `packages/telemetry/` shipped in same tarball** | Single install, single version, atomic upgrade, shared server/CLI/skills; `--ui` flag toggles at runtime; v1-pinning users just don't set the flag | Tarball roughly doubles (~600 KB+); users on slow networks pay v2 cost they don't use; v2 rollback = full version pin | +~400–800 KB unpacked depending on bundle splitting. Est. total: ~700–800 KB packed / ~2.0 MB unpacked |
| **(b) v2 as separate `packages/telemetry-v2-ui/`** | Independent release cadence; users opt-in via `npm i -g rh-telemetry-v2-ui`; v1 unchanged; clean PRs scoped per package | Two installs to coordinate (server vs UI), bin-name collision risk, two skills to install, server must discover whether v2 UI is installed and fall back; user-facing complexity | v1: ~unchanged. v2: ~400–500 KB packed (UI bundle + minimal glue) |
| **(c) v2 inside `packages/telemetry/` but excluded from default `npm pack`** | Same single-version, same atomic upgrade, v1 tarball stays lean; opt-in via secondary install vector (e.g., `rh-telemetry install-v2-ui` downloads from GitHub release or unpacks sibling artifact) | Extra distribution surface (GitHub release artifact, separate download path); makes air-gapped install awkward; v2 install step can fail post-`npm install -g` | v1: unchanged (~312 KB). v2 artifact: ~400–500 KB out-of-band |

### Recommendation

**Option (a) — ship v2 inside the same tarball, gated by `--ui v1|v2` flag and `RH_TELEMETRY_UI` env var, default v1 until v2 is stable.**

Rationale:
- User explicitly framed **npm plug-in delivery** as a constraint v2 must respect. Option (a) is the only choice that keeps `npm install -g rh-telemetry` as the one install command — no out-of-band download, no second package to keep in sync.
- 700–800 KB packed is well under common npm tarball sizes; convenience of atomic upgrade beats bandwidth saving.
- The env-flag coexistence model the v2 plan already commits to maps directly onto a single tarball with two `dist/` subtrees. Server picks the right static root at boot.
- Skills (`/rh-telemetry`, `/rh-telemetry-setup`) stay CLI-only and unaffected.
- Once v2 reaches parity, default flips to v2; v1 stays shippable for the deprecation window, then removed in a major-version bump.

**Concrete v2 work items this implies:**
1. Vite build config: dual-entry, output to `dist/v1/` and `dist/v2/`.
2. `package.json` `files`: keep `dist/` (both subdirs ship).
3. `server/index.js`: read `process.env.RH_TELEMETRY_UI || 'v1'`, serve from `dist/${ui}/`.
4. `bin/rh-telemetry.js`: `start` accepts `--ui v1|v2`, sets env var before spawning server.
5. Optional: `setup` subcommand prompts/records preferred UI in `~/.claude/rh-telemetry-config.json` so the choice persists.

## Source registry

| File | Lines read | Notes |
|---|---|---|
| `packages/telemetry/server/trends-router.js` | 77/77 | Full |
| `packages/telemetry/server/hook-receiver.js` | 301/301 | Full |
| `packages/telemetry/server/failure-store.js` | 275/275 | Full (last line: `}`) |
| `packages/telemetry/server/hook-perf-store.js` | 123/123 | Full |
| `packages/telemetry/server/hook-health.js` | 141/141 | Full |
| `packages/telemetry/server/statusline-watcher.js` | 68/68 | Full |
| `packages/telemetry/package.json` | 70/70 | Full |
| `packages/telemetry/bin/rh-telemetry.js` | 202/202 | Full |
| `packages/telemetry/scripts/install-skills.js` | 142/142 | Full |
| `packages/telemetry/src/components/TrendsTab.jsx` | 60/244 | Partial — sufficient for consumer pattern |
| `~/.claude/oversight-events.jsonl` | First 20 + last 20 of 2,266 + full `event_type` histogram via awk | 6 types confirmed |
| `npm pack --dry-run` output | Full | 41 files, 312.2 KB packed / 1.1 MB unpacked |

**Cross-references:** `wc -l` = 2,266 lines; awk event_type count = 2,268 (off by 2, near-match, likely awk false positives inside content_hash payloads).
**Subagent telemetry:** ~24% of 1M context window, 0 compactions.

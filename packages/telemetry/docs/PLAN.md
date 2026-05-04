# Claude Telemetry — Active Plan

**Created:** 2026-04-18
**Supersedes and retires:**
- `docs/FEATURE_ENRICHMENT_PLAN.md`
- `docs/statusline-integrity-plan.md`
- `docs/test-harness-plan.md`
- `docs/tool-validator-issues.md`
- `.claude/worktrees/bold-driscoll/PLAN-distribution-readiness.md`
- `.claude/worktrees/bold-driscoll/docs/FEATURE_ENRICHMENT_PLAN.md` (earlier draft of main file)

The retired plans were audited item-by-item against the current codebase on 2026-04-18. A summary of what landed (so none of the retired text needs to be preserved) appears at the bottom of this file under **Audit residue**. All unchecked work that survived the audit lives in the threads below.

Not retired (these are reference material, not plans):
- `docs/ui-design-origin-investigation.md`
- `docs/dashboard-cheat-sheet.md`
- `docs/architecture-diagram.pdf`

---

## Outstanding work

Two surviving threads. Thread 1 is committed (next session). Thread 2 is optional and gated on user interest.

---

## Thread 1 — Ship to npm  *(~1.5h)*

The repo has been cleaned for publishing (LICENSE, `files` allowlist, hardcoded paths removed, obsolete scripts deleted, README privacy section added). `npm publish` has not been run.

### 1.1 `.npmignore` tidy  ✅ DONE 2026-04-18

- [x] Remove `scripts/supervisory-agent-prompt.md` from `.npmignore` — file already deleted
- [x] Remove `scripts/supervisory-agent-prompt-v2.md` from `.npmignore` — file already deleted
- [x] Remove `scripts/tool-validator-v2.js` from `.npmignore` — it is the active validator, not an unused draft; must ship

### 1.2 Pre-publish verification  ✅ DONE 2026-04-18

- [x] `npm run build` — `dist/` produced cleanly (713 kB bundle, Recharts size warning only — known issue in CLAUDE.md)
- [x] `npm pack --dry-run` — 36 files, 270.7 kB, no `docs/`/`src/`/`tests/`/`CLAUDE.md`/`.claude/` content
- [x] `npm pack` — tarball at repo root: `rh-telemetry-1.0.0.tgz`. File list verified via `tar -tzf ... | sort`
- [x] Install test: tarball installs cleanly into `/tmp/tmp.cNdXFkmPdc`, `rh-telemetry --help` prints expected usage
- [x] Name check: `npm view rh-telemetry` → 404 (name is **available** on registry)

### 1.3 Publish  🟡 PICK UP HERE NEXT SESSION

**Blocker:** `npm whoami` returns ENEEDAUTH. `npm login` is interactive so it couldn't be run from the agent session.

- [ ] `npm login` — user runs interactively (browser or terminal flow)
- [ ] `npm publish` — confirm with user at this gate before running (irreversible, 72-hour unpublish window)
- [ ] `npm info rh-telemetry` — verify the version landed
- [ ] From a clean shell: `npm install -g rh-telemetry`, run `rh-telemetry setup` against a throwaway `HOME`, confirm hooks land
- [ ] If `1.0.0` ships with a problem, bump to `1.0.1` rather than `npm unpublish` unless within the 72-hour window

**State handoff:** tarball `rh-telemetry-1.0.0.tgz` at repo root is the artifact that would be published. `npm publish` packs fresh — the existing tarball is inspectable but not consumed by publish. Delete it (`rm rh-telemetry-1.0.0.tgz`) after publish succeeds.

### 1.4 Recovery notes

- If the name `rh-telemetry` is taken, switch to a scope: `@toolbeltross/rh-telemetry`, update `package.json → name`, re-run dry-run
- If a broken version ships, `npm unpublish rh-telemetry@1.0.0` works within 72 hours; otherwise publish `1.0.1` with the fix
- Publishing does not affect local development — no rollback needed for the repo

---

## Thread 2 — OTel enrichment  *(optional, ~3.5h in-scope)*

Claude Code ships official OpenTelemetry support. When enabled by the user's env vars (`CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_METRICS_EXPORTER=otlp`, `OTEL_LOGS_EXPORTER=otlp`, `OTEL_LOG_TOOL_DETAILS=1`, `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:7890`), tool events gain `mcp_server_name`, `skill_name`, `duration_ms`, and `tool_decision` signals that hooks don't expose.

**Scope decisions** — what survived vs. what was dropped from the old FEATURE_ENRICHMENT_PLAN:

| Old plan item | Verdict |
|---|---|
| F1 failure tracking (durationMs, unified stream, sliding-window alerts, failure rate column) | **RETIRED — DONE** (see Audit residue) |
| F2 OTel receiver | **IN SCOPE, scoped down** — minimal JSON parser, no OTel SDK dep |
| F3 MCP cost attribution | **IN SCOPE** — low complexity, answers a real question |
| F4 Skill invocation tracking | **IN SCOPE, shrunken** — pill strip, not a full table |
| F5 Permission denial pipeline | **DROPPED** — effectively already covered: `tool-validator-v2.js` POSTs `validation_block` on deny and `ToolActivity` already shows amber dots |
| F6 Subagent cost attribution | **RETIRED — DONE** — `server/store.js:547–588` populates `cost` + `costEstimated` via transcript metrics + context-history delta fallback |

### 2.1 Minimal OTel receiver  *(~2h)*

- [ ] Create `server/otel-receiver.js` — Express router handling OTLP/HTTP JSON. Parses ResourceLogs + ResourceMetrics envelopes by hand (no `@opentelemetry/*` dep). Extracts `tool_result`, `tool_decision`, `api_error` log records and basic cost/token metric gauges
- [ ] Mount at `/v1/logs` and `/v1/metrics` in `server/index.js` on the existing port 7890. Startup log: `[otel] receiver mounted on /v1/logs, /v1/metrics`
- [ ] Extend `store.addToolEvent()` to accept `durationMs`, `mcpServerName`, `skillName` — merge onto the existing tool event shape, do not fork a new event type
- [ ] Session correlation: OTel ResourceAttributes include `session.id`. Route enrichment into `liveSessions[id]`; drop silently with a debug log if the session is unknown
- [ ] Add `_otelConnected` flag on live session (set to `true` on first OTel event, cleared by the existing 2-hour prune). Surface as a small dot in the session tab header
- [ ] Add `rh-telemetry otel-setup` subcommand to `bin/rh-telemetry.js` — prints the env vars + a copy-paste shell-rc snippet, does NOT write to the user's shell rc automatically

**Verification:**
- [ ] Unit test `tests/unit/otel-receiver.test.js`: parse a known-good OTLP/HTTP JSON sample, assert the extracted fields match
- [ ] Integration test `tests/integration/otel-receiver.test.js`: POST a sample envelope to `/v1/logs`, snapshot shows the enriched tool event, `_otelConnected: true` on the session
- [ ] Degrade test: boot without OTel configured, confirm no warning spam, tool feed still works
- [ ] Wire failure path: POST malformed JSON, confirm server logs `[otel] parse error` and returns 400 without crashing

**Failure handling:** OTel parsing must never crash the main server. Wrap every parse step in try/catch. An unexpected schema shape logs `[otel] unexpected shape at <path>` and drops the record.

### 2.2 MCP attribution panel  *(~1h)*

- [ ] Add `_mcpUsage` map to live session: `{ [serverName]: { calls, failures, lastTool, lastUsedAt } }`. Populated by `addToolEvent()` when `mcpServerName` is set
- [ ] Create `src/components/McpBreakdown.jsx` — compact table (Server | Calls | Last Tool | Last Used), visible only when `_mcpUsage` is non-empty
- [ ] Mount below `ModelBreakdownMini` in `SessionTab.jsx` (conditional render)
- [ ] Add `GET /api/mcp-usage?sessionId=…` to `server/hook-receiver.js` for CLI queries
- [ ] Add `rh-telemetry mcp` subcommand to `scripts/telemetry-cli.js`

**Verification:**
- [ ] Browser test `tests/browser/mcp-breakdown.test.js`: seed an OTLP event with `mcp_server_name: "desktop-commander"` via the existing `/api/_test/state` endpoint, confirm the panel appears
- [ ] CLI: `rh-telemetry mcp` prints the breakdown

### 2.3 Skill invocation pill strip  *(~30min, defer if not needed)*

Shrunken from the old plan's full `SkillActivity` panel — the data is useful but doesn't justify a separate panel.

- [ ] Add `_skillInvocations` map to live session: `{ [skillName]: count }`
- [ ] Render as a pill strip in the `SessionMetaStrip` row: `/telemetry ×3  /session ×1` — only visible when non-empty
- [ ] No separate CLI command, no separate panel

**Verification:**
- [ ] Browser test: seed a `skill_name` event, confirm the pill appears in the meta strip

### 2.4 Recovery notes

- Thread 2 is entirely additive. Incomplete? Existing features keep working
- OTel receiver errors log-and-drop. Never cascade to Claude Code
- If the OTel schema changes upstream, the receiver should fail closed: log the shape mismatch, drop the record, continue serving

---

## Open questions before starting Thread 2

1. **Is Thread 2 worth it?** The hook pipeline already provides tool names, durations (often), and failure status. OTel adds MCP server attribution and skill invocation — real but narrow wins. If you're not using many MCP tools or skills, Thread 2 has low yield. Dogfood Thread 1 first, then decide
2. **OTel transport:** recommend OTLP/HTTP (JSON, port `/v1/logs`) over OTLP/gRPC (protobuf, separate port) — zero binary deps
3. **OTel port:** recommend same port 7890 — no new process, existing CORS works
4. **Subagent attribution accuracy:** current implementation in `store.js` uses context-history delta as a fallback when transcript metrics are unavailable. If OTel eventually emits per-subagent cost, wire it in as the preferred source; until then the delta estimate is good enough

---

## Total effort

| Thread | Effort |
|---|---|
| 1 — npm publish | ~1.5h |
| 2.1 — OTel receiver | ~2h |
| 2.2 — MCP panel | ~1h |
| 2.3 — Skill pills (optional) | ~30m |
| **Total** | **~5h** (1.5h committed, ~3.5h optional) |

---

## Prerequisites

- Node 18+ on PATH (already required by the project)
- An npm account with publish rights to the `rh-telemetry` name — or a decision to use a scope
- For Thread 2 dogfooding: a shell with `CLAUDE_CODE_ENABLE_TELEMETRY=1` + related env vars set

---

## Audit residue — what landed from the retired plans

Verified against the codebase on 2026-04-18. Listed so the retired plan files can be deleted without losing the history of what they asked for.

**`test-harness-plan.md` — all phases complete.** Evidence:
- `tests/run.js`, `tests/{unit,integration,browser}/`, `tests/helpers/{tmp,ports,server,ws-client,test-harness}.js`, `tests/fixtures/{settings,hooks,transcripts}/`
- `.githooks/pre-commit`, `scripts/install-git-hooks.js`, `package.json` has `test`, `test:unit`, `test:integration`, `test:browser`, `test:all`, `test:visual`
- `Store` class exported alongside singleton in `server/store.js`
- CLAUDE.md `## Testing` section present

**`statusline-integrity-plan.md` — all 7 code phases complete.** Evidence:
- Phase 1: `scripts/statusline-classifier.js`, `scripts/statusline-history.js`, `server/config.js` has `STATUS_LINE_STALL_MS`, `tests/unit/classifier.test.js`
- Phase 2: `scripts/repair-statusline.js`, `rh-telemetry repair-statusline` subcommand in `bin/rh-telemetry.js`
- Phase 3: `scripts/generate-statusline-wrapper.js`, `tests/unit/wrapper-source.test.js`
- Phase 4: `statusLineState` in store, `server/statusline-watcher.js`, boot-time classification
- Phase 5: `_source: 'statusLine'` / `_source: 'toolPiggyback'` in `scripts/hook-forwarder.js:252,402`; discrimination in `server/hook-receiver.js:45`; stall detection in store
- Phase 6: `server/broadcaster.js:123` relays `statusLineState`
- Phase 7: `src/components/StatusLineBanner.jsx` + `StatusLineModal` mounted in `src/App.jsx:10,398,449,572`

**`tool-validator-issues.md` — all items already marked `[x]`.** Replaced v1 validator with `scripts/tool-validator-v2.js` (allowlist + SUGGEST-not-BLOCK, notifies server on deny); `tests/integration/tool-validator.test.js`; `filterOurEntries` in `setup-hooks.js` no longer references removed prompt-hook markers.

**`FEATURE_ENRICHMENT_PLAN.md` Phase A — complete.** Evidence:
- A1: `durationMs` in `server/failure-store.js:48,59`
- A2: unified tool event stream — failure rates computed in `FailureHistory.jsx:39–144`
- A3: `server/failure-alerting.js` + `tests/unit/failure-alerter.test.js`
- A4: failure rate column in `FailureHistory.jsx` (rate badge + per-tool rate)
- A5: `server/cost-rates.js` + `tests/unit/cost-rates.test.js`
- A6: subagent cost estimation in `server/store.js:547–588` (transcript primary, context-history delta fallback)
- A7: `AgentActivity.jsx` shows cost with `costEstimated` flag
- A8: `scripts/tool-validator-v2.js:71` calls `notifyServer('Bash', 'validation_block', ...)`

**`PLAN-distribution-readiness.md` — almost all complete.** Evidence:
- 1.1–1.2: `package.json → files: ["bin/","server/","scripts/*.js","dist/"]` — no `docs/`, no `src/`
- 1.3: `setup-hooks.js` no longer has `['Ross Here','rossb']` multi-profile logic or `--target` flag
- 1.4: `LICENSE` (MIT, "Copyright (c) 2026 Ross Beveridge")
- 1.5: `cross-env` removed from `package.json` entirely (not in deps or devDeps)
- 2.1: obsolete scripts gone (`tool-validator.js`, `statusline.js`, `progress-tracker.js`, `supervisory-agent-prompt.md`, `supervisory-agent-prompt-v2.md`)
- 2.2: `filterOurEntries` in `scripts/setup-hooks.js:45–137` has no dead string references
- 3.1: README no longer says "3-layer validation" or has wrong hook count (verified via grep)
- 3.2: `README.md:100–103` has Privacy section describing credential reading
- 4.1–4.2: repo on `github.com/toolbeltross/rh-telemetry` matching `package.json`
- 4.3: `.npmignore` exists (Thread 1.1 tidies remaining stale entries)

Remaining from that plan is only Thread 1 above (`.npmignore` tidy + actual publish).

**Earlier worktree draft of `FEATURE_ENRICHMENT_PLAN.md`** — superseded by the main-repo version before the main version was itself retired here. Nothing unique to carry over.

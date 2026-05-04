# README screenshots

The `../../README.md` at the repo root references images in this folder. To produce them from a live session:

1. Run `rh-telemetry start` and let a real Claude Code session accumulate data.
2. Open `http://localhost:7890`.
3. Capture the panels listed below — either manually (browser screenshot) or with the Playwright-based `tests/browser/harness.js` driving seeded state.

## Image list (filenames referenced in README)

| File | Panel / phenomenon |
|------|--------------------|
| `agents-orphaned.png` | Agents tab with a red "likely orphaned" badge and a `↻ Nx compacted` chip |
| `stop-hook-loop.png` | Session tab with a red "Possible Stop-hook loop" banner |
| `events-and-failures.png` | Events & Failures tab with mixed-color rows (failure red, validation amber, suggestion green, config cyan, orphan purple) + error-class chips at top |
| `context-window.png` | Context Window panel at >70% usage with cache-hit ratio visible |
| `cost-breakdown.png` | ModelBreakdown donut showing Opus parent + Haiku/Sonnet subagents, plus TurnCostChart with a visible spike |
| `failure-patterns.png` | FailureHistory patterns view with class chips (`not_found · 8`, etc.) and top-3 most expensive failures panel |
| `hook-health.png` | Events & Failures tab header with green "hooks ok" chip top-right |

## Seeding synthetic data (for repeatable screenshots)

The test harness seeds realistic data via `/api/_test/state` when `RH_TELEMETRY_TEST_MODE=1` is set. That endpoint is how the Playwright browser tests produce deterministic UI states. The same pattern can be used to produce README screenshots:

```js
// Start server with RH_TELEMETRY_TEST_MODE=1
// POST a session, a compact event, a stuck agent, a string of failures, etc.
// Open the dashboard, take the screenshot, kill the server.
```

See `tests/browser/*.test.js` for reference patterns.

## Privacy note

When capturing real session data for public screenshots, make sure to either:
- crop workspace paths that include personal usernames, or
- run against a throwaway project in `/tmp/demo` with generic content.

The dashboard's own UI already truncates session ids to 8 characters in most places; cost figures are what they are.

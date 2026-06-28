# Archive — packages/telemetry

Retired telemetry artifacts kept for provenance (not deleted). Added during the 2026-06-20 cleanup audit.

## Design-spec screenshots — `Screenshot 2026-03-06 *.png` (5) — REMOVED
Early dashboard design-reference screenshots (2026-03-06), carried over wholesale from the standalone `rh-telemetry` repo during the monorepo migration (commit `f91cc47`). They lived in `packages/telemetry/Specifications/` and were referenced nowhere in the codebase.

**Removed 2026-06-28 and purged from git history** (security audit): one of the captures (`Screenshot 2026-03-06 010534.png`) included a terminal pane that exposed a developer machine's username/hostname and a local filesystem path. As they served no documentation purpose, the five images were deleted from the working tree and scrubbed from all history via `git filter-repo`.

## `PLAN-distribution-readiness.md`
npm-distribution-readiness plan, **CLOSED 2026-05-06** (npm publication not pursued; the package is consumed via local clone of `rh-claude-framework`). Retained as a historical record of the pre-publish hygiene that did land.

# Phase 0.4 — v2 Tech Stack Decision

> Research output from subagent dispatch, 2026-05-20. Source registry at bottom.

## Stack candidate comparison

| Criterion | A: Status quo (React 19 + Vite + Tailwind v4 + Recharts) | B: Shadcn-aligned (React 19 + Vite + Tailwind v4 + shadcn/ui + Radix + Recharts) | C1: SolidJS + Vite + Tailwind v4 | C2: SvelteKit (compiled) + Tailwind v4 |
|---|---|---|---|---|
| Component-lift from v1 | 100% verbatim | 100% verbatim (shadcn coexists, JSX unchanged) | 0% — JSX → JSX-like requires rewrite of every component | 0% — full Svelte rewrite |
| Bundle delta vs v1 (~500KB) | ±0KB | +30-80KB (Radix primitives, tree-shakeable) | -200 to -300KB (Solid is ~10KB runtime) | -250 to -350KB (no runtime) |
| Design-system rigor | Low — ad-hoc Tailwind, no primitives | High — Radix a11y, shadcn copy-paste owned-in-repo | Low — same ad-hoc Tailwind story | Medium — would need new system |
| Dev iteration speed | Highest — team already fluent | High once shadcn registry seeded | Low — relearning + porting | Low — full rewrite |
| Workspace alignment (`shadcn-kit/`, `html-kit/`) | None — diverges from stated direction | Strong — directly consumes `shadcn-kit/`; Radix + Inter + JetBrains Mono in `html-kit/` is the same stack | None | None |
| Stack churn risk | None (already shipping) | Low — shadcn is copy-paste source, not a runtime dep | High — Solid ecosystem thinner for charting | High — would also need Recharts replacement |
| Charts | Recharts works | Recharts works (or shadcn chart wrapper over Recharts) | Recharts incompatible; need solid-chart or D3 | Recharts incompatible; need svelte-chartjs or layer cake |
| Bundle splitting story | Recharts is the >500KB offender; manual code-split needed regardless | Same — but shadcn chart wrapper makes per-route lazy import natural | Better default | Best default |
| npm tarball delta | +0KB | Shadcn lives in source tree (not deps), so devDeps bump (Radix) hits node_modules only, not the published tarball | +Solid runtime in dist | +compiled output, smallest dist |

## Per-candidate evaluation

**A — Status quo extended.** Lowest risk, lowest reward. Every v1 component lifts verbatim. But this candidate solves none of the underlying drift problem: the v1 codebase already exists, the *reason* we're rewriting is that the existing structure put stale data in the front and live oversight signals in the back. A re-skin under the same primitives leaves us hand-building accessible menus, dialogs, popovers, and command palettes for every new surface (Oversight, Subagents). The 500KB bundle problem is owned by Recharts and persists regardless. Picking A means accepting that v2 work is purely IA + new components, with no design-system payoff and no workspace alignment.

**B — Shadcn-aligned.** Highest leverage. Shadcn/ui is a copy-paste registry (no npm dep), so existing JSX components migrate verbatim while new surfaces get production-grade Radix primitives for free. The header (model legend, env-flag indicator, command palette), the Oversight tab (event table with sortable columns, filter popover, expand-row drawer), and the Subagents tab (cross-session leaderboard with column visibility menu) all map cleanly to existing shadcn recipes. The model-color trio (`MODEL_COLORS` in `src/lib/model-colors.js`) stays the visual contract — only the surrounding chrome gets shadcn-ified. The `claude-setup-ross/shadcn-kit/` and `claude-setup-ross/html-kit/` (Radix + Inter + JetBrains Mono + PrimeVue Aura) signal is unambiguous: the user is standardizing on Radix-class primitives across personal tooling, and v2 should ride that wave. Bundle delta is modest (Radix primitives tree-shake well). The `>500KB` issue resolves the same way under A or B (code-split Recharts per route), so it's not a differentiator.

**C1 — SolidJS.** Genuinely tempting on perf (the dashboard is a heartbeat-heavy live view), but the lift cost is brutal: 27 components in `packages/telemetry/src/components/` all become rewrites, and Recharts becomes unavailable. The 500KB win mostly comes from dropping Recharts — which we could do under A or B without changing frameworks. Not worth it for a tool whose pain point is information architecture, not render performance.

**C2 — SvelteKit.** Same lift problem as C1, plus a routing model (SvelteKit's filesystem routing) that doesn't match the single-page WebSocket-driven shape of this app. Rejected on cost-of-rewrite grounds.

## Recommendation: B — Shadcn-aligned

**Rationale:**
1. **Zero migration friction** for existing JSX. `ContextWindow.jsx`, `ModelBreakdown*.jsx`, `TurnHeartbeat.jsx`, `SubagentTimeline.jsx`, `FailureHistory.jsx`, `TrendsTab.jsx` lift unchanged — shadcn is additive, not replacement. The `model-colors.js` source-of-truth stays canonical.
2. **Workspace alignment is the deciding factor.** The user has staged `shadcn-kit/` and `html-kit/` as design-system targets. Picking anything else means actively diverging from their declared direction.
3. **New surfaces benefit immediately.** Oversight, Subagents, and Sessions each want sortable tables, filter popovers, command palettes, and detail drawers — all native shadcn components.
4. **No runtime dep on shadcn.** Components are copy-paste owned by the repo. Stack churn risk is bounded by Radix's own stability, which is very high.
5. **npm tarball footprint unchanged.** Shadcn lives in source; only devDependencies grow (Radix primitives), which doesn't ship.

## "Why not" — rejected options

**Why not A:** It solves no architectural problem. The v2 IA work is the same under A or B; B costs roughly one extra week of component primitive setup and pays back forever in design-system rigor + workspace alignment.

**Why not C1 (Solid):** The lift cost (27 component rewrites + chart-library swap) is wildly disproportionate to the perf gain on a dashboard whose bottleneck is WebSocket fan-out, not render. The Recharts-driven 500KB bundle issue is independently solvable.

**Why not C2 (Svelte):** Same rewrite problem as C1, plus routing-model mismatch with a single-page WebSocket app. No upside justifies the burn.

## Open questions / conditional dependencies on parallel Phase 0 work

- **Depends on 0.1 (stats-cache cause):** if Path A (cache recoverable), the History surface keeps existing stats-cache reads and the v2 IA collapses History into a single surface. If Path B (live aggregation), the new `aggregates-store.js` becomes the canonical source and the History surface gets a heavier component. Stack choice is unaffected either way.
- **Depends on 0.2/0.3 (API coverage):** if a substantial number of WS events are broadcast but never rendered (likely, per the PLAN), the Live surface needs more components than v1 has — shadcn's pre-built recipes (Card, Tabs, Sheet, Command) become more valuable.
- **Depends on 0.6 (oversight + npm):** if `oversight-events.jsonl` has 8+ event types, dedicated Oversight tab is mandatory. If <5 distinct types, fold into Sessions tab as a column. Stack-side: shadcn's data-table primitive handles either path.
- **Conditional bundle decision:** if 0.6 measures current `npm pack` tarball at >10MB, ship v2 as separate optional package (`rh-telemetry-ui-v2`). If <5MB, bundle both `dist/` and `dist-v2/` in same tarball under env-flag mount.
- **Charts library:** stick with Recharts (already proven, lifts verbatim). Reconsider only if 0.6 measures the production bundle and confirms >50% of total weight is Recharts AND code-splitting per route doesn't recover enough.

## Verification gap (subagent disclosed)

The subagent searched the local clone for `claude-setup-ross/shadcn-kit/` and `claude-setup-ross/html-kit/` and **did not find them on disk** in this checkout (which is `toolbeltross-public/rh-claude-framework/`, not the full Workspace tree). Recommendation rests on the user's stated workspace-direction signal per `Workspace/CLAUDE.md`. Specific shadcn component recipe references would need to be verified against the actual `shadcn-kit/` when v2 implementation starts.

## Source registry

| File | Lines read | Notes |
|---|---|---|
| `packages/telemetry/CLAUDE.md` | 1–426 of 426 | Full; token line 426: `- Not yet published to npm — npm publish when ready` |
| `packages/telemetry/PLAN-20260520-frontend-v2.md` | 1–236 of 236 | Full at time of read |
| `packages/telemetry/package.json` | 1–71 of 71 | Full; token line 71: `}` |
| `packages/telemetry/docs/STYLEGUIDE.md` | 1–100 | Partial |
| `packages/telemetry/src/lib/model-colors.js` | Full 47/47 | Token line 47: `};` |
| `packages/telemetry/src/App.jsx` | 1–470 | Partial |
| Components: `OverviewTab.jsx`, `SubagentTimeline.jsx`, `TrendsTab.jsx` | Partial heads | Sufficient for IA mapping |
| `Workspace/CLAUDE.md` | 1–100 | Partial |

**Subagent telemetry:** ~25% of 1M context window, 0 compactions. Word count for combined 0.4 + 0.5 ≈ 2,800 (under 3,000 budget).

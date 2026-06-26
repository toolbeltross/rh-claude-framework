# Telemetry Dashboard Styleguide

Canonical reference for the dashboard's visual system. Designers and contributors should read this before adding or modifying components.

This file is the source of truth for **tokens, type, color usage, and component conventions**. The user-facing meaning of each dashboard section lives in [`dashboard-cheat-sheet.md`](dashboard-cheat-sheet.md). The architectural layout lives in [`../CLAUDE.md`](../CLAUDE.md).

---

## 1. Token source of truth

| Token type | Defined in | Consumed via |
|---|---|---|
| All theme colors (`gray-*`, `accent`, `green`, `red`, `amber`, `blue`, `cyan`, `accent-dim`) | [`src/index.css`](../src/index.css) `@theme` block | Tailwind utilities (`text-accent`, `bg-red/10`, `border-cyan/40`, …) |
| Model-family colors + Tailwind class tuples | [`src/lib/model-colors.js`](../src/lib/model-colors.js) | `getModelColor()`, `getModelFamily()`, `MODEL_HEX` |
| Tool / agent identity colors (file I/O, shell, orchestration, meta) | [`src/lib/style-tokens.js`](../src/lib/style-tokens.js) | `getToolColor()`, `getAgentTypeColor()`, `IDENTITY` |

**Rule:** never hardcode a hex literal inside a component. If you need a color, it must come from one of these three modules. If you need a new one, add it to the module first and then consume it.

The Tailwind `@theme` block is the single hex source. `model-colors.js` mirrors the same three hex values for the model trio — if you change one, change the other.

---

## 2. Color tokens — hex + usage

| Token | Hex | Tailwind class | When to use |
|---|---|---|---|
| `gray-950` | `#0a0a0f` | `bg-gray-950` | Page background, inactive tab background |
| `gray-900` | `#111118` | `bg-gray-900` | Panel background, active tab background |
| `gray-800` | `#1a1a24` | `bg-gray-800` / `border-gray-800` | Panel borders, hover state on inactive controls |
| `gray-700` | `#2a2a38` | `bg-gray-700` / `border-gray-700` | Chart axes, divider lines, scrollbar thumb |
| `gray-600` | `#3a3a4a` | `text-gray-600` | Inactive dot, placeholder `—`, scrollbar thumb hover, faint badges |
| `gray-400` | `#8888a0` | `text-gray-400` | Section-header label color, secondary text |
| `gray-300` | `#aaaabb` | `text-gray-300` | Primary value text, table cells, tool-label text |
| `gray-100` | `#e0e0ee` | `text-gray-100` | **Default for non-categorical metric values** (counts, totals, dates) |
| `accent` (purple) | `#8b5cf6` | `text-accent`, `bg-accent/10`, `border-accent/30` | **Opus** model family; primary highlights; subagent stripe; Opus model-switch marker |
| `accent-dim` | `#6d28d9` | `bg-accent-dim` | Reserved for pressed/active accent state |
| `blue` | `#60a5fa` | `text-blue`, `bg-blue/10` | **Sonnet** model family; uncached input tokens; idle session dot; Sonnet model-switch marker |
| `cyan` | `#22d3ee` | `text-cyan`, `bg-cyan/10` | **Haiku** model family; cache tokens; active agent count; Haiku model-switch marker |
| `green` | `#34d399` | `text-green`, `bg-green/10`, `bg-green/[0.03]` | Live/processing dot; output tokens; success tool dots; heartbeat playhead; cost values when explicitly cost-coded; row accent for active rows |
| `amber` | `#fbbf24` | `text-amber`, `bg-amber/10` | Cache writes; validation-blocked tool dots; elevated latency (p95); high-usage warnings (50–80%); compaction marker in heartbeat; agent-cost emphasis |
| `pink` | `#f472b6` | `text-pink`, `bg-pink/10` | **Fable** model family (added 2026-06-12 — same reservation rule as the Opus/Sonnet/Haiku trio) |
| `red` | `#f87171` | `text-red`, `bg-red/10`, `border-red/40` | Errors; failures; critical context (>80%); forced-continuation marker; row accent for orphaned/error rows; "TOTAL FAILURES" card only |

### Color rules

1. **Reserve the model colors (pink / purple / blue / cyan)** for actual model attribution. Don't paint a "Total Sessions" card purple just because purple looks accent-y — that creates visual ambiguity with Opus.
2. **Default metric color is `text-gray-100`.** Use red only when the value represents a failure/alert state. Use green only when the value semantically *is* a success/cost figure that uses the green semantic.
3. **Status colors are reserved:** green = live/success, amber = warning/blocked, red = error/critical. Don't use them for decoration.
4. **`/10` background tints + `/30–/40` borders** are the badge/highlight idiom — see §5 Badges.

---

## 3. Typography

The dashboard is a monospace-first information display. The font stack lives in [`src/index.css:4-5`](../src/index.css:4) — SF Mono → Cascadia Code → Fira Code → JetBrains Mono → ui-monospace fallback.

### Type scale

| Role | Tailwind | Example use |
|---|---|---|
| Section header | `text-xs font-semibold uppercase tracking-wider text-gray-400` | `CONTEXT`, `TOOLS`, `AGENTS`, `TURN HISTORY` |
| Sub-section header | `text-[10px] font-semibold uppercase tracking-wider text-gray-500` | Inline column labels in detail panels |
| Body / value | `text-xs` or `text-sm` | Table cells, list rows |
| Emphasized value | `text-sm font-bold font-mono` or `text-base font-bold font-mono` | Stat numbers in header strips |
| Hero value | `text-2xl font-mono font-bold` | Context fill percentage only |
| Badge text | `text-[10px]` (or `text-[9px]` in dense strips) | Status pills, count chips |
| Metadata caption | `text-[10px] text-gray-500` or `text-[9px] text-gray-600` | Timestamps, tool counts in row corners |

Don't introduce new sizes ad hoc. If something doesn't fit, use the next step up or down — and ask whether the existing data really needs more emphasis than its neighbors.

---

## 4. Section headers

Every panel and every tab content area opens with a `SECTION ⓘ` row:

```jsx
<span className="text-xs font-semibold uppercase tracking-wider text-gray-400 inline-flex items-center gap-1.5">
  Tools <InfoIcon>{infoContent}</InfoIcon>
</span>
```

**This is mandatory.** Empty-state panels still need a header — without it, the empty view looks like a layout bug. (Closed: `TurnsTab.jsx` empty state.)

`InfoIcon` (ⓘ) accepts a children body with `Legend` components for color callouts:

```jsx
<InfoIcon>
  <div className="space-y-1.5">
    <p>What this panel means.</p>
    <div className="flex flex-wrap gap-x-1 gap-y-0.5">
      <Legend color="bg-green" label="active" />
      <Legend color="bg-red" label="failed" />
    </div>
  </div>
</InfoIcon>
```

---

## 5. Badges

Rounded-full pill, three-color trio (background tint + text + border):

```jsx
<span className="px-1.5 py-0 text-[10px] rounded-full bg-red/10 text-red border border-red/40">
  3 fails
</span>
```

| Use | Background | Text | Border |
|---|---|---|---|
| Error / failure | `bg-red/10` | `text-red` | `border-red/40` |
| Warning / blocked | `bg-amber/10` | `text-amber` | `border-amber/40` |
| Active count | `bg-cyan/20` | `text-cyan` | (no border, font-mono) |
| Tool event count | `bg-gray-800` | `text-gray-400` | (no border, font-mono) |
| Neutral / version | `bg-gray-800/50` | `text-gray-500` | `border-gray-700` |

Padding: `px-1.5 py-0`. Size: `text-[10px]` (or `text-[9px]` when packed into dense strips).

### Pluralization

Always pluralize correctly. Don't write "1 fails" — write "1 fail" / "2 fails", or use "1 failure" / "2 failures". A one-liner conditional is fine:

```jsx
{n === 1 ? '1 fail' : `${n} fails`}
```

---

## 6. Row-level status accents

In tables, status is conveyed by a 3px left-edge accent applied via inline `boxShadow`:

```jsx
<td style={{ boxShadow: 'inset 3px 0 0 var(--color-green)' }}>…</td>
```

| Color | Meaning |
|---|---|
| `var(--color-green)` | Active / processing row |
| `var(--color-red)` | Orphaned / error row |
| (no accent) | Completed / normal row |

Don't paint the entire row background. The accent + a `bg-{color}/[0.03]` row tint is the maximum.

---

## 7. Status dots

Small circle indicators (`w-1.5 h-1.5` to `w-2 h-2`, `rounded-full`). Color = state:

| Color | Meaning | Behavior |
|---|---|---|
| `bg-green` | Live / success | Pulses (`animate-pulse-dot`) when active |
| `bg-red` | Failure / orphaned | Pulses if also stale |
| `bg-amber` | Blocked / warning / idle | Static |
| `bg-blue` | Idle (session-level) | Static |
| `bg-gray-600` | Completed / inactive | Static |

For session tabs, the dot also signals processing state via `animate-pulse-dot`.

---

## 8. Tooltips

**Native `title` attributes only.** No custom hover components, no JS-driven tooltip libraries. Every interactive or color-coded element gets a `title=`.

```jsx
<span title="Tokens reused from cache — 90% cheaper than new input">
  Cache Read
</span>
```

Hover is for clarification only. Don't use hover to reveal interactive controls.

---

## 9. Progressive disclosure (3 levels)

1. **Inline summary** — the row or card itself shows the scan-level view.
2. **`title` hover** — full text without layout disruption (browser tooltip).
3. **Click-to-expand** — detail panel renders below the clicked row/card with full content.

Click is for detail panels. Hover is for tooltips. Never hover-to-expand.

---

## 10. Long text in table cells

Single-line, no wrap, clip cleanly:

```jsx
<td className="whitespace-nowrap overflow-hidden" title={fullText}>
  {fullText}
</td>
```

No ellipsis — let the text run to the cell edge and clip. Hover (`title`) and click-to-expand provide the full content. This keeps row heights stable.

---

## 11. Side-by-side panels (equal height)

Use CSS Grid with `grid-template-columns: 1fr 1fr`. Wrap each label+panel in a flex column with the panel set to `flex-1`:

```jsx
<div className="grid grid-cols-2 gap-1.5">
  <div className="flex flex-col">
    <div className="text-[9px] uppercase tracking-wider text-gray-600 mb-0.5">Prompt</div>
    <div className="flex-1 min-h-[60px] max-h-40 overflow-y-auto …">{prompt}</div>
  </div>
  <div className="flex flex-col">
    <div className="text-[9px] uppercase tracking-wider text-gray-600 mb-0.5">Result</div>
    <div className="flex-1 min-h-[60px] max-h-40 overflow-y-auto …">{result}</div>
  </div>
</div>
```

Never set independent `max-height` on each panel — that breaks equal height. Set `max-height` on the grid container (or the flex cell) if you need scroll.

---

## 12. Empty states

Centered gray text, lowercase noun phrase:

```jsx
<div className="flex items-center justify-center py-6 text-xs text-gray-500">
  No agent events yet
</div>
```

Template: `No {thing} yet` (or `No {thing} recorded yet`). Use `text-gray-500`, never `text-gray-400` (which is reserved for active labels).

**Empty panels still need a section header above them** — see §4.

---

## 13. Number, date, and money formatting

| Value type | Format | Example |
|---|---|---|
| Token counts < 1K | bare integer | `847` |
| Token counts 1K–1M | `N.Nk` with one decimal | `12.4K` |
| Token counts ≥ 1M | `N.NM` with one decimal | `1.4M` |
| Cost ≥ $0.01 | `$N.NN` (two decimals) | `$0.42` |
| Cost < $0.01 | `$N.NNNN` (four decimals) | `$0.0023` |
| Percentage | bare integer + `%` | `47%` |
| Duration < 60s | `Ns` | `42s` |
| Duration ≥ 60s | `MmSSs` | `3m12s` |
| Date (single) | `YYYY-MM-DD` | `2026-04-15` |
| Date (chart axis) | `MM-DD` | `04-15` |
| Missing / unknown value | `—` (em dash) — never `0`, never `$0.00` | `—` |

The `—` placeholder is `text-gray-600` (faintest body color). When you write `0` for an unknown value, the reader can't tell whether the system is reporting zero or doesn't know — always use `—` for missing data.

---

## 14. Anti-patterns

- ❌ Inline hex literals in components (`fill="#8b5cf6"`). Use tokens.
- ❌ Painting non-categorical metrics in model-family colors. (Reserve purple/blue/cyan for model attribution.)
- ❌ Custom hover popovers or tooltip components.
- ❌ Showing `0` for unknown/missing values.
- ❌ Mixed date locales on one screen.
- ❌ Skipping section headers in empty-state panels.
- ❌ Pluralization mismatches ("1 fails", "1 turns").
- ❌ Multiple max-widths for the same kind of tab — pick one.
- ❌ Decorative use of status colors.

---

## 15. When to update this file

- New token added to `index.css` or `style-tokens.js` → add a row to §2 or §1.
- New badge variant introduced → add to §5.
- New formatting convention adopted → add to §13.
- Existing rule revised → keep the revision summary brief and link to the related PR.

This file is the canonical contract. Other docs may summarize it but should defer here for the actual rules.

---
title: How to trace a project's UI/feature origin through Claude Code subagent transcripts
type: how-to
created: 2026-04-14
updated: 2026-04-19
sources:
  - "~/.claude/projects/"
tags: [how-to, ui, forensics, transcripts, design-history]
---

# How to trace a project's UI/feature origin through Claude Code subagent transcripts

Recover the design history of a Claude-built project by mining its own session transcripts — when git history is too shallow and memory files weren't written.

## When to use this

- You want to know *where an idea came from* in a project Claude helped build, and git history starts mid-project or was reinit'd
- You suspect a specific influence ("did I tell Claude to look at Grafana?") but can't remember which session
- You want to distinguish **user-provided intent** from **agent-inferred defaults** — i.e., how much of the current quality was explicitly requested vs. opinionated choices the agent made on your behalf
- You need decision lineage for an ADR, a wiki page, or a review and your memory files don't have it

Do NOT use this when recent git history + commit messages already give you the answer — that's faster and more reliable.

## Prerequisites

- The project was built with Claude Code (sessions stored under `~/.claude/projects/`)
- Python 3 with UTF-8 output (`PYTHONIOENCODING=utf-8` on Windows to avoid charmap errors)
- Ability to read JSONL files

## Steps

### 1. Enumerate every project directory the repo has lived in

Projects that moved locations on disk leave behind multiple `~/.claude/projects/<hashed-path>/` entries, each with its own session history. Miss one, miss history.

```bash
ls ~/.claude/projects/ | grep -i <project-keyword>
```

For each match, record: the path, the count of top-level `.jsonl` files (parent sessions), and whether there's a nested `<session-id>/subagents/` subdirectory (dispatched subagent transcripts).

### 2. Distinguish parent sessions from subagent transcripts

- Top-level `<session-id>.jsonl` in the project dir = **parent sessions** (main conversations)
- `<session-id>/subagents/agent-<hash>.jsonl` = **subagent dispatches** (agents spawned via the Agent tool)

Some project locations only preserve one or the other. Early directories often keep subagent transcripts but lose their parent sessions, because the parent sessions lived under an older project path that was later migrated.

### 3. Collect all transcripts across all locations, sorted by mtime

```python
import os, glob
all_files = []
for base in project_dirs:
    for f in glob.glob(os.path.join(base, '*.jsonl')):
        all_files.append(('parent', os.path.getmtime(f), f))
    for f in glob.glob(os.path.join(base, '*', 'subagents', 'agent-*.jsonl')):
        all_files.append(('subagent', os.path.getmtime(f), f))
all_files.sort(key=lambda x: x[1])
```

Report the earliest and latest timestamps. This gives you the **evidence horizon** — anything before the earliest timestamp is lost to you, no matter what the actual project history was.

### 4. Search the first user prompt of each subagent for target keywords

The first user message of a subagent is the brief it was dispatched with. It usually quotes the parent's intent verbatim and is the highest-signal place to find "who asked for X and why."

Use Python + regex — not `grep` — because JSONL content has escaped newlines that break line-oriented tools. Read only the first line of each file, parse as JSON, pull the first user text block.

Search for multiple keyword families in parallel:

- **Direct asks** — what you think you said ("look at Grafana", "professional dashboard", "modern UI")
- **Adjacent research** — what an agent might have searched for on its own (look for WebSearch queries and WebFetch URLs)
- **Named sources** — specific sites you'd expect the influence to come from (grafana.com, honeycomb.io, sentry.io, etc.)

### 5. Read assistant *responses*, not just prompts

This is the step most investigations skip — and get wrong. A subagent's **prompt** tells you what was asked. Its **final assistant message** tells you what was delivered. These can be very different.

A "research the state of the art in X" brief *sounds* like it could have shaped visual design. Reading the actual report can prove it was a metric/architecture survey with zero visual observations. The prompt misleads; the response clarifies. For each promising subagent, read the last assistant text block in the transcript — it's usually the synthesized report.

### 6. Distinguish "fetched URL X" from "observed anything useful from X"

A subagent that WebFetches `grafana.com` is easy to cherry-pick as "the Grafana inspiration moment." But if the subagent's report contains no visual observations — no mentions of color, layout, typography, spacing, palette, screenshot — then the URL fetch was not the design influence. Grep the response text for visual vocabulary before crediting a source.

### 7. Disclose evidence gaps explicitly

If the earliest parent session on disk is dated N days after the project was created, there are N days of parent-context work you cannot recover. Never present findings as "the origin" if the real origin predates your evidence horizon. Say: *"Among the subagent dispatches that survive, none is X. I cannot rule out that it happened in parent context."*

## Verification

- **Count cross-check**: total subagents found should roughly match the project's development intensity. An empty subagent set for a mature project means you're in the wrong directory.
- **Timestamp sanity**: earliest mtime should be plausibly close to project creation. If not, you've missed a project location.
- **Spot check by reading one subagent end-to-end**: pick any `agent-*.jsonl` and read it fully. Does the first user message describe a task you recognize? If not, you might be looking at a different project's transcripts.

## Common failures

- **"The obvious culprit is the answer."** The subagent that fetched Grafana sounds like the design origin, but reading its report shows it was a metric survey. Always read responses, not just prompts.
- **Missing parent transcripts.** Early project directories sometimes preserve only subagents. You can see what was dispatched but not why. Call this out explicitly rather than extrapolating.
- **Project-directory hash collisions from path moves.** A repo that moved between disk locations has multiple unrelated hash dirs under `~/.claude/projects/`. Enumerating only the current one gives a biased view.
- **UTF-8 encoding errors on Windows.** Default Python stdout encoding is `cp1252`; transcripts contain Unicode. Set `PYTHONIOENCODING=utf-8` before running.
- **Prompt-heavy, response-light searches.** Grep across all files finds keyword matches everywhere, but most matches will be in `tool_result` content (pages the agent fetched), not the agent's own observations. Narrow to prompts and final responses.
- **Trusting stored memory over disk.** Persistent memory files (under `~/.claude/projects/<hash>/memory/`) capture only what past sessions explicitly saved. For design history, they're almost always silent. Go to the transcripts.

## Example: tracing the rh-telemetry dashboard's UI origin

**Question asked:** *Where did this project's UI look-and-feel come from? Did we look at professional dashboards on the internet?*

**What the investigation found:**

- Project had lived in 6 `~/.claude/projects/` locations over ~40 days, holding 141+ transcripts
- Earliest location preserved only subagent dispatches; parent sessions for the first 13 days were gone
- Three load-bearing subagents survived:
  1. **2026-03-04 initial architect** (`agent-a5d9124`) — chose React + Vite + Tailwind + Recharts and dark-theme monospace from a 4-bullet user brief that never mentioned visuals
  2. **2026-03-04 tabbed-layout restructure** (`agent-a4118d2`) — explicitly described the prior state as *"one flat grid with everything mixed together"*; moved the dashboard to hierarchical tabs
  3. **2026-03-06 state-of-the-art research** (`agent-a05d41e`) — the one subagent that fetched Honeycomb, Sentry, Grafana

**What the "obvious culprit" turned out to be:** the March 6 research subagent. Its prompt asked for *"what the smartest developers are doing and what patterns Anthropic recommends"* — which sounds like it could seed a "look like Grafana" design direction.

**What reading the response proved:** its 9,500-character report has **zero visual observations**. Grep for `color`, `dark`, `theme`, `monospace`, `palette`, `layout`, `typography`, `spacing`, `screenshot`, `aesthetic` — none appear. Every actionable recommendation was a **capability** (OTel integration, subagent call graphs, predictive metrics, governance features) — never a visual to borrow. The research contributed metric taxonomy and architectural validation, not the look and feel.

**Actual contributors to the UI quality** (after cross-checking prompts, responses, and repo state):

1. **Opinionated defaults by the initial architect subagent** — dark theme + monospace + React/Tailwind, chosen without being told
2. **The tabbed-layout restructure** — the single biggest perceived-quality leap in the project
3. **Three invisible CLAUDE.md enforcement rules** — information priority order, tooltips-on-everything, single source of truth for model colors in `src/lib/model-colors.js`
4. **~13 days of parent-context polish that no longer exists on disk** — the evidence gap

**The false lead avoided:** crediting the Grafana fetch as the design origin would have been a clean, publishable story. It would also have been wrong, and would have pointed future UI improvement efforts toward *"fetch more Grafana pages"* when the actual levers are restructuring passes and CLAUDE.md rule-tightening.

## See Also

- [CLAUDE.md](../../CLAUDE.md) — the information priority order and tooltip rules that enforce visual consistency without look-research
- [src/lib/model-colors.js](../../src/lib/model-colors.js) — single source of truth for model colors
- [docs/ui-design-origin-investigation.md](../ui-design-origin-investigation.md) — raw investigation report (the question-form version of this how-to)

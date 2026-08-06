---
name: rh-recall
description: Search everything already worked out — past session transcripts, scribe rows and their LLM proposals, shared learnings, per-project memory, and the concept graph — before deriving something from scratch. Use when a question sounds like it may have been answered in an earlier session, when starting work in an unfamiliar area, or when the user references a prior decision.
argument-hint: "<terms to recall>"
---

Recall across every memory store for: **$ARGUMENTS**

```
!`node "$HOME/.claude/scripts/rh-recall.js" "$ARGUMENTS"`
```

## How to use what comes back

The stores answer different questions — read them for what each is good at:

| Section | What it tells you |
|---|---|
| **Concept graph** | Which ideas are linked to this one. Follow `↳ links:` to concepts that would otherwise look far-flung. |
| **Project memory** | Standing facts and user rulings for a project. Highest authority — these are deliberate. |
| **Shared learnings** | Cross-project techniques and decision rules. |
| **Scribe rows + proposals** | Open cleanup/recommendation items. A `↳ proposal:` line is an LLM triage verdict already produced for that row — read it before re-analysing. |
| **Past session transcripts** | What was actually said and decided, with session id and project. |
| **Oversight logs** | Hook/telemetry events — useful for "when did this start failing". |

Then:

1. **Say what you found before acting.** If recall answers the question, cite the file or
   session id and move on — that is the whole point. Do not silently re-derive it.
2. **Treat memory as dated, not current.** A memory can outlive its evidence, and a fresh
   session reads memory before it reads the repo. If a hit names a file, flag, or count,
   re-verify at source before relying on it.
3. **Prefer the source of truth.** The `.md` files are canonical; Postgres is a local index
   over them and can lag or be absent entirely.
4. **Note anything reported as degraded.** A `⚠ degraded` line means a store was NOT
   searched on this machine — absence of hits there is not evidence of absence.

## Options

`--limit N` per-source cap (default 6) · `--days N` restrict time-based stores ·
`--source graph,memory,learnings,scribe,transcripts,logs` · `--json`

## Notes

- Identifier-shaped queries (paths, file names, hyphenated slugs) are relaxed automatically,
  because Postgres indexes those as single atomic tokens and cannot match a fragment. If a
  query returns nothing, try plain prose words as well.
- Works on machines without Postgres or without the oversight system — the `.md`-backed
  stores always run, and anything unavailable is reported rather than silently skipped.

---
description: "Definition of 'done' for multi-source consolidation tasks; facilitator requirement; prohibited self-certification language"
---

# Completion Standards

## Multi-Source Task Completion Gate

A consolidation, synthesis, or analysis task is ONLY complete when ALL of these hold:

1. **Verification tokens recorded** — literal first line returned from each source file,
   not from memory or prior session context.

2. **Line counts confirmed** — reported line count matches the actual file (via Bash wc -l
   or Glob). If counts disagree, re-read.

3. **Partial reads disclosed** — if any source was partially read, the output document
   says so explicitly. Example: "COMMINGLING_ANALYSIS_REPORT.md lines 1–150 of 862 read;
   lines 151–862 not incorporated."

4. **Source Registry present** — output document contains a table with:
   file path | total lines | lines read | verification token | sections contributed

5. **External source checklist checked** — if the task brief listed an "external sources"
   or "unincorporated sources" section, each item must be checked and disposition recorded
   (incorporated / not available / out of scope).

## Prohibited Self-Certification Language

Do not use these phrases unless ALL 5 criteria above are met:
- "consolidation complete"
- "all sources incorporated"
- "comprehensive reference"
- "master document"
- "single source of truth"
- "fully synthesized"

If criteria are not met: state what IS done, what is NOT done, and what is needed to finish.

## Facilitator Requirement

Any task reading > 5 source documents must be dispatched through the facilitator agent,
not through direct reads in main context. The facilitator enforces batch dispatch
and subagent oversight protocol by design.

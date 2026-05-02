---
description: "Read tool truncation handling and source attribution standards for consolidation tasks"
---

# Read Integrity

## Truncation is a Failure — Not a Fallback

The Read tool silently returns partial content when files exceed ~10K tokens (≈400–500 lines).
A partial read MUST be treated as a failure unless explicitly handled.

**When a Read call returns less than the full file:**
1. STOP — do not proceed as if the read was complete
2. Disclose immediately: "File X has N lines; I read lines 1–Y. Lines Y+1 to N not read."
3. Either: read the remainder using offset+limit, OR dispatch to a subagent
4. NEVER label a file as "read," "incorporated," or "subsumed" without covering all sections

## Verification Tokens on Direct Reads

For any consolidation, synthesis, or source-attribution task, record for every file:
- Literal first line (verbatim) — the verification token
- Total line count of the file
- Which lines were actually read (e.g., "lines 1–200 of 639")

Do not include a file in any source registry without this data.

## Large File Thresholds

| File size      | Required approach                                       |
|---------------|---------------------------------------------------------|
| < 400 lines    | Direct Read is fine                                     |
| 400–800 lines  | Use offset/limit reads; log which sections covered      |
| > 800 lines    | Dispatch to a subagent with the oversight protocol      |

## The "Subsumed" Prohibition

Never use: "subsumed," "incorporated," "consolidated," "accounted for," "comprehensive"
to describe a source document unless a verification token has been recorded for it.

If sources were listed but not read: say "listed but not read — requires follow-up."

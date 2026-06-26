---
description: "Full decomposition of user messages before any action — prevents keyword-latching and missed nuance"
keywords: [parse, decompose, hierarchical, path separator, org/repo, entity, nuance, qualifier, subordinate clause, pattern match]
severity: warn
---

# Input Parsing

## Parse Before Acting — Not While Acting

Claude defaults to pattern-matching on salient keywords and acting immediately.
This produces errors when user messages contain structured inputs, hierarchical identifiers,
or nuanced implications embedded in casual phrasing.

**Before every tool call or action, confirm:**
1. You have identified ALL distinct entities in the message (orgs, repos, paths, names, teams, members, versions, identifiers)
2. Any path-like or hierarchical input has been fully decomposed with each component labeled
3. You have not skipped or dismissed any clause, aside, or qualifier in the message
4. Your planned action is consistent with the FULL message, not just the most prominent keyword

## Hierarchical Input Decomposition

When an argument contains path separators (`\`, `/`, `.`) or resembles a hierarchy:

| Pattern | Common Structure in This Workspace |
|---------|------------------------------------|
| `a\b\c` or `a/b/c` | GitHub-org \ repo \ team-member |
| `a\b\c\d` | org \ repo \ member \ project |
| `a/b#123` | org/repo#issue-number |

- Decompose the ENTIRE structure before using any single component as a parameter
- The last token is NOT automatically the most important — it is often the narrowest scope
- The first token is often the org or root context — do not discard it

## Nuance Detection

The user communicates with intentional compression: brief mentions may carry outsized implications.

- A casual aside ("like I said", "as I mentioned") often references a prior constraint you missed
- A subordinate clause may redefine the target, scope, or approach
- If you find yourself ignoring part of the message to simplify your action, STOP — that part likely matters
- When uncertain about which entity the user means, ask — do not guess

## Prohibited Shortcuts

- Do not extract a single token from a structured string without decomposing the full string
- Do not act on partial message parsing — read the whole thing first
- Do not assume the last word in a path is the primary identifier
- Do not conflate similarly-named entities (e.g., `acme-org` the org vs `acme-user` the user)

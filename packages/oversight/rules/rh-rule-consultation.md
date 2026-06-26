---
description: "Consult workspace rules before answering in a domain a rule covers — cascade-loaded rules are inputs, not ambience"
keywords: [consult, rule, cascade, before answering, domain, applies_to, frontmatter]
severity: warn
---

# Rule Consultation

## Principle

The CLAUDE.md cascade and `.claude/rules/*.md` files load at session start. They are **inputs to consult**, not ambient context to skim. When the work touches a domain a rule covers, the rule body should be Read in-session (or its content meaningfully recalled with the rule cited) before producing a recommendation.

## Why this rule exists

Cascade-loading does not enforce consultation. The 2026-05-31 session (`d82b184a`) produced six consecutive Rule-3 rejections in the first 188 turns because Claude made claims about loaded-but-unread rule content — `rh-tool-selection.md`'s pdf-reader guidance, `rh-read-integrity.md`'s threshold definitions, the CLAUDE.md cascade-loading mechanism itself. All six rules were already in context; none were consulted before answering.

This rule does not replace the Stop-hook supervisor (which catches violations after-the-fact). It is the upstream discipline that prevents the violations from being produced.

## Frontmatter convention (shipped on all 12 workspace rules)

Every workspace rule includes `keywords:` and `severity:` frontmatter. The `keywords:` field lists the domain terms the rule covers. Sample:

```yaml
---
description: "Environment-aware tool selection rules for multi-user, multi-environment workspace"
keywords: [environment, claude-desktop, cli, vscode, MCP, desktop-commander, visual verification, screenshot, playwright, preview, pdf-reader, ENTRYPOINT]
severity: warn
---
```

Use the `keywords:` field as a fast self-check: if the answer you are about to give mentions any of a rule's keywords in a substantive way, that rule covers your answer's domain — consult it before answering.

## How to apply

Before producing any answer that recommends a tool, approach, file, or process:

1. **Self-check:** does the answer touch a domain covered by any cascade-loaded rule's `keywords:` field?
2. **If yes:**
   - If the rule body is short (under ~50 lines), recall + cite the specific passage.
   - If the rule body is longer or your recall is uncertain, **Read the rule file in-session** and cite the line.
   - The cited rule should appear in the answer, not just in your reasoning.
3. **If no:** proceed.

The cost is one Read per substantive answer in a covered domain. The benefit is that the rule's guidance reaches the user as a sourced fact, not as a paraphrase from training memory.

## Interaction with the Layer-3a supervisor

The Stop-hook Layer-3a supervisor checks Rule 3 (NO UNVERIFIED EXTRAPOLATION) after the assistant turn ends. When a rejection cites a rule, the supervisor (per the B2 tightening, 2026-06-01) inlines a verbatim RULE BODY quote in the rejection so Claude has the source on retry. This rule is the upstream version: consult on the way in, so the rejection on the way out is unnecessary.

## What this rule does NOT require

- Reading every rule in the cascade for every turn. The trigger is *the answer touches a covered domain*, not *a session is in progress*.
- Re-reading a rule in every turn of a long conversation. Once consulted in a session, the content is in context for the duration.
- Treating tangential domain-keyword matches as triggers. The test is whether the rule's *guidance* applies, not whether a keyword happens to appear.

## Failure modes this rule mitigates

- **Cascade-as-ambience** (the session-1 failure pattern): rules loaded but ignored.
- **Repeated Rule-3 rejections on the same source-adequacy gap**: by consulting upstream, the violation isn't produced.
- **Tangential answers in covered domains** (e.g., recommending a screenshot strategy in a session where `rh-tool-selection.md`'s broken-surface matrix applies).

## Origin

Plan §5.1.1(a) proposal + 2026-05-31 session post-mortem. Codified 2026-06-01. Whether a corresponding `rh-rule-consultation-guard.js` hook should also be built is a separate decision pending B2 data; this rule operates as guidance regardless of guard status.

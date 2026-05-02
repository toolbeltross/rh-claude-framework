---
description: "Verify work end-to-end before presenting it as complete, tested, or ready"
---

# Work Verification

## Principle

Before telling the user work is "done", "ready", "tested", or "complete", verify it **through the same interfaces the user will hit**, not just through the pieces you happened to write last.

This rule exists because a component can be locally correct and still broken at the seam where it meets the rest of the system. "I wrote it and the unit I tested passed" is not the same as "the thing works."

## Required before declaring "done" / "tested"

- [ ] Every test suite you claim to have run has actually been executed end-to-end, not just the one you most recently added.
- [ ] Every user-facing command mentioned in the change has been invoked through its **actual entry point** (the `bin` script, the `npm run` alias, the CLI subcommand, the git hook, the deployed URL) — not just the underlying script it wraps.
- [ ] Every regression-adjacent test suite that already exists has been re-run after changes that could affect it. Adding a new feature is not an excuse to skip re-running the old tests.
- [ ] Every failure path claimed in a plan has been either exercised or explicitly flagged as "not exercised in this pass."

## The "standalone vs through-the-seam" trap

If you test a hook by running `bash .githooks/pre-commit`, you have tested the script.
You have **not** tested whether `git commit` actually invokes it.

If you call a library function directly in a test, you have tested the function.
You have **not** tested whether the CLI subcommand that calls it is wired correctly.

If you open a modal via `window.dispatchEvent(...)` from DevTools, you have tested the handler.
You have **not** tested whether the button the user clicks reaches that handler.

Always verify the outer seam, not just the inner unit. When you use a shortcut because the outer seam is inconvenient, flag that explicitly in the status report.

## Pre-delivery checklist (before every "ready for review" or "it's done" message)

Before composing a status / completion message:

1. **Re-run the primary test entry point** the user would run (`npm test`, `npm run test:all`, `pytest`, etc.), not just the individual file you just authored.
2. **Invoke any changed CLI surface through its actual dispatcher**, not the underlying script.
3. **Sanity-check adjacent features**: if you changed the store, run the broadcaster test. If you changed the API, run the frontend integration test. If you changed hook format, exercise a real hook.
4. **Check the filesystem**: no leftover tmp dirs, no orphaned processes, no uncommitted state you didn't intend.
5. **Read your own status message back** and ask: *does every claim in this message correspond to something I actually verified in this session, or am I extrapolating?*

If step 5 reveals extrapolation, either verify it or downgrade the claim to "implemented but not verified in this session."

## When to relax

- **Pure documentation / prose changes**: re-running the full test suite is not required. A build / render smoke check is enough.
- **Actions the user explicitly approved skipping** (e.g. "don't bother running the browser tier for this tiny fix"). Honor scope.
- **Tests that would have destructive side effects on the user's live environment** (e.g. rewriting their real `~/.claude/settings.json`). Isolate with tmp fixtures instead and say so.

## Honest gap reporting

If the user asks "is it tested" or "is it done" or "is it ready", give an honest breakdown:

- **Verified this session:** the specific things you actually ran.
- **Not verified — gaps:** anything you implemented but did not exercise end-to-end.
- **Out of scope:** anything excluded by the task definition.

"Yes, it's done" without that breakdown is only acceptable when every claim in the implementation has been exercised through its outer seam. If there are any gaps, they must be enumerated before the user asks for them.

## Required in every go-forward plan file

Any file that acts as a go-forward / consolidation / loose-ends plan (e.g., `LOOSE_ENDS_YYYY-MM-DD.md`, `PLAN-*.md`, `ROADMAP.md`) MUST contain a **"What is PARTIAL"** section that lists each item where the inner edit landed but the outer seam was NOT exercised. Template:

```markdown
## What is VERIFIED via outer seam
| Item | Verification |
|---|---|
| ... | ... |

## What is PARTIAL (not verified via outer seam)
| Item | Status | Linked LE / item ID |
|---|---|---|
| ... | code-reviewed, not run through `npm run X` | LE-NN |
```

`layer3-pickup-2026-04-19.md` (archived) is the canonical exemplar. Without a PARTIAL section, a plan file silently implies all items are outer-seam verified — which is almost never true and reintroduces the very failure mode this rule exists to prevent.

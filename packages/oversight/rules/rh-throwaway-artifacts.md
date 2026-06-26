---
description: "Routing convention for throwaway / disposable artifacts written into project working directories"
keywords: [tmp, screenshots, throwaway, artifact, scratch, png, gitignore, playwright, browser_take_screenshot, Playwright MCP, verification, disposable, cwd]
severity: warn
---

# Throwaway Artifact Routing

## Principle

Disposable artifacts — verification screenshots, scratch outputs, API-response dumps, OCR-prep images, one-off test files — belong under a gitignored `tmp/` directory in the project root. They must NOT be written to the repo root or scattered in source directories.

This convention applies to **files written into a project working directory**. OS-level temp-directory writes (`/tmp/`, `%TEMP%`) are outside scope — they are ephemeral and live outside any repo.

## The rule

**All throwaway artifacts written into a project working directory go under `tmp/`.**

- Verification screenshots: `tmp/screenshots/`
- Figma API response dumps, raw JSON: `tmp/figma-api/`
- ERD exports, scratch DB outputs: `tmp/` (or a named subfolder)
- Any other one-off file that is not a committed source artifact: `tmp/<subfolder>/`

Every project that uses tools emitting files to cwd should have `tmp/` in its `.gitignore`.

## Tool-specific guidance

**Playwright MCP `browser_take_screenshot`** writes to cwd by default. Always pass an explicit path:

```
tmp/screenshots/<descriptive-name>.png
```

Do not rely on the gitignore's `/*.png` wildcard as the routing mechanism — that is a safety net, not the routing convention. Route first; gitignore catches leakage.

**Playwright CLI** (`npx playwright screenshot URL out.png`) in pipeline use should write to the OS temp directory (`/tmp/shot.png` on bash-on-Windows, which aliases to `%TEMP%`), not to the project's `tmp/`. That is the correct path for ephemeral pipeline intermediates.

**Any tool that defaults to cwd** (file exporters, screenshot tools, log dumpers): pass an explicit `tmp/<subfolder>/` path rather than accepting the default.

## New projects

When scaffolding a new project:

1. Create `tmp/.gitkeep` (so the directory exists but stays empty in git)
2. Add `tmp/` to `.gitignore`

The `tmp/` directory should include a comment in `.gitignore` that names its purpose, e.g.:

```
# Local scratch / throwaway artifacts (screenshots, API dumps, one-off outputs)
tmp/
```

## What this rule does NOT cover

- Intentional committed assets (e.g., a `hero.png` that is a genuine repo asset checked in deliberately). Those do not belong in `tmp/` and are not covered by this rule.
- OS-level temp writes used in ephemeral tool pipelines (rh-tool-selection.md's Playwright CLI pipeline correctly writes to `/tmp/shot.png`).
- Log files covered by their own gitignore patterns (`*.log`, etc.).

## Interaction with adjacent rules

- **rh-doc-placement.md**: the broader placement convention. This rule owns the disposable-`tmp/` detail (the "Temp / throwaway" category); `rh-doc-placement.md` is the full category map (docs / data / temp / project-tracking) and the home for new placement conventions. If you're deciding where a *non-throwaway* file goes, start there.
- **rh-conventions.md**: this rule extends it. rh-conventions.md covers path conventions and file naming; this rule adds artifact routing.
- **rh-tool-selection.md**: the Playwright CLI pipeline section writes to `/tmp/` (OS temp). That is correct and intentional — this rule does not change it. Distinguish: OS `/tmp/` = ephemeral pipeline; project `tmp/` = disposable but project-scoped.
- **rh-work-verification.md**: verification screenshots are artifacts of the outer-seam verification step. They are still required; this rule only says where to put them.

## Failure mode this rule mitigates

Silent accumulation of untracked/gitignored files at repo root — either leaking into git status noise or silently suppressed by a catch-all gitignore. Evidence: `rh-platform-agentbuild` accumulated hero.png, erd.png, pw-mcp-test.png, lr-creation-flow-verification.png at root and required defensive `/*.png` and `_screenshots/` gitignore lines (lines 55-57 of `.gitignore`). This convention routes proactively so other projects do not re-derive the same gitignore patches.

## Origin

2026-06-13 incident: Playwright MCP `browser_take_screenshot` deposited 4 verification screenshots at the root of `rh-platform-agentbuild` during a session review. User direction: add as a global convention. Steward review approved 2026-06-13.

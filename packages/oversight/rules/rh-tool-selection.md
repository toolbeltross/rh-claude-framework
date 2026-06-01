---
description: "Environment-aware tool selection rules for multi-user, multi-environment workspace"
keywords: [environment, claude-desktop, cli, vscode, MCP, desktop-commander, visual verification, screenshot, playwright, preview, pdf-reader, ENTRYPOINT]
severity: warn
---

# Tool Selection Rules

## Environment Detection (run at session start)

At the start of each session, detect the environment:
```bash
echo $CLAUDE_CODE_ENTRYPOINT
```
- `claude-desktop` → Claude Code Desktop app (full MCP suite)
- `cli` → Claude Code CLI (workspace MCP only)
- `vscode` → Claude Code in VS Code (workspace MCP only)
- empty/absent → Standalone Claude Desktop (desktop-commander only, no built-in tools)

## Tool Preference: Built-in vs Desktop-Commander

Prefer built-in tools for standard operations. Use desktop-commander (DC) only for capabilities built-ins lack.

| Operation | Use | Not | Use DC only when |
|-----------|-----|-----|-----------------|
| Read text file | `Read` | `dc__read_file` | Excel, DOCX, URL, negative offset |
| Write text file | `Write` | `dc__write_file` | Excel, DOCX, append mode |
| Edit text file | `Edit` | `dc__edit_block` | Excel ranges, DOCX XML edits |
| Find files | `Glob` | `dc__list_directory` | Need depth-limited tree view |
| Search contents | `Grep` | `dc__start_search` | Need streaming/background search |
| Run commands | `Bash` | `dc__start_process` | REPLs, long-running, process mgmt |
| Read single PDF | `Read` | `pdf-reader` | Multi-PDF parallel, tables, images |
| Read file > 800 lines | subagent with oversight protocol | direct `Read` in main context | Never — always use subagent for files this large |

## Desktop-Only Tools (never attempt from CLI or VS Code)

These MCP tools exist ONLY in the Claude Code Desktop app:
- `mcp__Claude_in_Chrome__*` (browser automation)
- `mcp__c24bbf0a-*__slack_*` (Slack messaging)
- `mcp__Claude_Preview__*` (dev server preview) — **see "Visual Verification" rule below**
- `mcp__scheduled-tasks__*` (recurring task runner)
- `mcp__mcp-registry__*` (connector discovery)

If environment is `cli` or `vscode`, do NOT call these tools.

## Visual Verification (rewritten 2026-04-25 after Playwright MCP benchmark)

Anthropic's own best-practices doc says: *"Include tests, screenshots, or expected outputs so Claude can check itself. This is the single highest-leverage thing you can do."* — the goal is **digestible verification when needed**. All pipelines and surfaces below tested working on this machine (Windows 11, bash on Windows, Claude Code Desktop) on 2026-04-25.

### Strengths / weaknesses matrix — pick the right tool for the job

| Tool | DOM / text | Computed style | Element screenshot | Full-page screenshot | Console errors | OCR / pixel parsing | Notes |
|---|---|---|---|---|---|---|---|
| **`mcp__playwright__*`** | ✅ ARIA tree YAML auto-saved on every `browser_navigate` | ✅ `browser_evaluate` | ✅ `browser_take_screenshot` with `ref=eN` from snapshot | ✅ `fullPage: true` | ✅ auto-saved on navigate | n/a | **No timeouts encountered. Primary surface.** |
| `mcp__Claude_in_Chrome__*` | ✅ `read_page`, `find`, `javascript_tool` | ✅ `javascript_tool` | ❌ CDP timeout 30s | ❌ same | ✅ `read_console_messages` | n/a | DOM tools fine; **`computer screenshot` action broken** |
| `mcp__Claude_Preview__*` | ✅ `preview_snapshot`, `preview_inspect`, `preview_eval` | ✅ `preview_eval` | ❌ banned | ❌ banned | ✅ `preview_console_logs` | n/a | Issue #30122 closed "not planned"; **`preview_screenshot` banned** |
| Playwright CLI via Bash | (HTML source only) | n/a | n/a (no element refs) | ✅ `npx playwright screenshot URL out.png` | n/a | n/a | Headless, no MCP dependency — last-resort capture |
| `Bash(curl …)` + `Grep` | source-text only | n/a | n/a | n/a | n/a | n/a | Confirms a server response or static text |
| Pillow (Python) | n/a | n/a | post-process | post-process | n/a | crop / resize / contrast | Color-preserved preview |
| ImageMagick CLI | n/a | n/a | post-process | post-process | n/a | grayscale + contrast-stretch + sharpen | Best for OCR-prep — halves file size vs Pillow color |
| Tesseract OCR | n/a | n/a | n/a | n/a | n/a | text-from-pixels | Good on prose; **mangles styled chip pills + code-with-bg** (verified) |
| `mcp__computer-use__screenshot` | n/a | n/a | n/a (full screen) | n/a (full screen) | n/a | n/a | OS-level capture; untested for this workflow |

### Surface ranking — which to reach for first

| Rank | Surface | Use for | Why this rank |
|---|---|---|---|
| 1 | **`mcp__playwright__*`** | DEFAULT. ARIA accessibility-tree on every navigate; computed style via evaluate; element-scoped screenshots that succeed; auto console-log capture | Verified deterministic 2026-04-25 across navigate / snapshot / evaluate / element-screenshot — only surface that does ALL of those without a CDP timeout |
| 2 | `mcp__Claude_in_Chrome__*` (DOM/text only) | When already mid-Chrome flow; secondary computed-style queries | DOM tools fine, but `computer screenshot` action is broken — don't bother with screenshots here |
| 3 | Playwright CLI via Bash | Headless URL→PNG capture independent of any MCP layer | Useful for non-interactive tests / batch captures / when MCPs are misbehaving |
| 4 | `Bash(curl …)` + `Grep` / `Read` | Source-level "does the served file contain string X" | Cheapest first-pass before involving any renderer at all |
| 5 | `mcp__Claude_Preview__*` text tools | Last-resort DOM reads | `preview_snapshot` / `preview_inspect` / `preview_eval` work; `preview_screenshot` banned (Issue #30122) |

### Decision tree — what to reach for

1. *"Is the page rendering correctly?"* → `mcp__playwright__browser_navigate` (the auto-snapshot answers most "what does the page look like" questions)
2. *"Does this element have the right computed style?"* → `mcp__playwright__browser_evaluate` with `getComputedStyle(...)`
3. *"Does this specific element render visually?"* → `mcp__playwright__browser_take_screenshot` with `ref` from the snapshot
4. *"Did my CSS edit land in the served file?"* → `Bash(curl)` + `Grep`
5. *"What does this section's DOM say about this component?"* → grep the saved Playwright snapshot, OR `browser_evaluate` for specifics
6. *"I need a screenshot Claude can OCR text from"* → Playwright element screenshot if possible; otherwise Playwright CLI + ImageMagick crop+grayscale + Tesseract
7. *"Tesseract mangled the chip pills"* → fall back to `browser_evaluate` for DOM text — chip/code text is reliable from the DOM, never from OCR

### Surfaces that are BROKEN (do not use for screenshots on this machine)

| Surface | Failure mode | Source |
|---|---|---|
| `mcp__Claude_Preview__preview_screenshot` | Times out at 30s; `preview_eval` reports `viewport: 0×0` | Anthropic Issue #30122 (closed "not planned") |
| `mcp__Claude_in_Chrome__computer` `screenshot` action | Times out: *"CDP sendCommand 'Page.captureScreenshot' timed out after 30000ms on tab N. The renderer may be frozen or unresponsive."* | Reproduced 2026-04-25 |

If you need a pixel image of a rendered page, **use the Playwright CLI pipeline below instead**.

### Tested pipeline — URL to digestible image

All paths verified working 2026-04-25.

```bash
# 1) Capture (Playwright CLI, npx-cached, no MCP)
npx -y playwright@1.59.1 screenshot \
  --viewport-size=1280,900 --browser=chromium \
  --wait-for-selector='#anchor-id' \
  "http://localhost:8765/path/to/page.html#anchor-id" \
  /tmp/shot.png
# Note: bash /tmp/ aliases to C:/Users/<user>/AppData/Local/Temp/ on Windows.
# Pillow needs the Windows path. Use $USERPROFILE or $HOME to resolve dynamically.

# 2a) Crop + cap to vision-limit (Pillow — color-preserved, for human/Claude review)
python -c "
import os; TEMP = os.environ.get('TEMP', '/tmp')
from PIL import Image, ImageEnhance
img = Image.open(os.path.join(TEMP, 'shot.png'))
img = img.crop((LEFT, TOP, RIGHT, BOTTOM))
img.thumbnail((1568, 1568))     # cap long edge at Anthropic vision limit
ImageEnhance.Contrast(img).enhance(1.2).save(os.path.join(TEMP, 'shot-color.png'))
"

# 2b) Crop + grayscale + sharpen (ImageMagick — smallest file, best for OCR / Claude vision)
magick \
  "/tmp/shot.png" \
  -crop WIDTHxHEIGHT+LEFT+TOP \
  -colorspace Gray -contrast-stretch 5%x5% -sharpen 0x1 \
  "/tmp/shot-prep.png"
# Tested: 1280x900 source 172KB → 724x570 grayscale prep 24KB. Halves file size vs Pillow color.

# 3) Optional OCR (Tesseract)
tesseract \
  "/tmp/shot-prep.png" \
  "/tmp/shot-ocr" \
  --psm 6 -l eng
cat "/tmp/shot-ocr.txt"
```

### Preprocessing — when to pick which

| Goal | Tool | Why |
|---|---|---|
| Faithful color preview of a UI region | Pillow + `--enhance(1.2)` | API simpler, color preserved |
| OCR fallback / smallest token cost / best Claude-readability | ImageMagick (grayscale + contrast-stretch + sharpen) | Halves file size; OCR sees fewer artifacts |
| Quick text extraction from prose-heavy pages | Tesseract on the magick-prepped PNG | Works well on body text |
| Text extraction from styled chips / code-with-bg / kit pills | **DON'T use OCR** — go DOM via `javascript_tool` | Verified 2026-04-25: Tesseract mangles `.chip` pills (`Verified` → `(EVIE)`) and code spans with background (`<Card>` → bracket noise) |

### Sizing constraints (Anthropic vision docs verbatim)

- *"If the image contains important text, make sure it's legible and not too small."*
- *"Consider pre-resizing and/or cropping your images."*
- Long edge **≤ 1568px** for Sonnet/Haiku (Opus 4.7: 2576px). Larger = silently downscaled, no fidelity gain.
- **PNG** for text-heavy / UI screenshots (heavy JPEG compression hurts text legibility).
- Token cost ≈ `width × height / 750`.

### Required tooling

| Tool | Purpose | Install |
|---|---|---|
| Node.js 18+ | Script runtime | Required |
| npx | Playwright CLI capture | Bundled with Node |
| Pillow (Python) | Image crop/resize | `pip install Pillow` |
| Playwright | Browser automation | `npx -y playwright@latest install chromium` |
| ImageMagick (optional) | Grayscale + sharpen for OCR prep | Platform package manager |
| Tesseract (optional) | OCR text extraction | Platform package manager |
| Playwright MCP | `mcpServers.playwright` in `~/.claude.json` | Recommended for visual verification |

### Parallel sessions — `--isolated` flag (2026-04-25)

When two Claude Code sessions run side-by-side in the same workspace, both spawn `npx @playwright/mcp@latest` and — by default — share the same `mcp-{channel}-{workspace-hash}` user-data-dir. Chromium can't open the same profile twice → mid-session crash.

**Mitigation in place:** `~/.claude.json` `mcpServers.playwright.args` includes `--isolated`. Verbatim from `npx @playwright/mcp@latest --help`:

> `--isolated` — keep the browser profile in memory, do not save it to disk.

Each session gets an ephemeral profile; no contention. Trade-off: cookies / localStorage don't persist between Playwright MCP runs (fine for visual-verification work, irrelevant for HTML doc QA).

**Verification command** (run any time you suspect the flag isn't being applied):

```bash
npx -y @playwright/mcp@latest --help | grep -i "isolated\|user-data-dir\|--port"
```

Should return three lines confirming `--isolated`, `--user-data-dir`, and `--port` are recognized in v0.0.70+.

### What NOT to do

- Don't claim "verified" off DOM-attribute reads from a renderer in unknown state (`window.innerWidth: 0` means the renderer isn't visible — reads may be stale).
- Don't reach for `preview_screenshot` or Chrome MCP `computer screenshot` on this machine — both reproducibly time out after 30s.
- Don't pass full-page screenshots > 1568px long edge — they get downscaled, you pay more for less.
- Don't OCR styled chip/code pills — go DOM via `browser_evaluate` / `javascript_tool` instead. Tesseract mangles them.
- Don't burn turns interpreting pixel images when a DOM query would answer the question deterministically.
- **Don't retry the same screenshot surface after a 30s timeout.** Telemetry shows 39 historical failures of this class with retry chains of 3–4 on the same broken tool — that's 90–120s and 3+ turns burned per attempt. **Escalate to the next surface tier immediately.**

### Figma and other WebGL/canvas web apps (default: desktop app + computer-use)

Figma — and any whiteboard / map editor / design tool that renders on a `<canvas>` — is **not a
normal web page**. Its content is WebGL pixels, not DOM, so `read_page` / `get_page_text` /
`browser_evaluate` return nothing useful. The decision tree above does not apply.

**Default method (verified 2026-05-18):** drive the **native desktop app** with **computer-use**.

1. Open the file in the app's **desktop client** (Figma desktop app, etc.), logged into the
   correct account.
2. `request_access` (computer-use) for the app — native apps are granted **full tier**
   (click / scroll / type / screenshot), unlike browsers which are read-tier.
3. `open_application` to bring it frontmost, then `screenshot` + `zoom` + `left_click` / `scroll`.

**Do NOT use the browser route for canvas apps.** Tested and rejected: computer-use blocks
clicks on browsers (read tier); the Chrome-extension MCP `computer` action is broken here
(`Cannot access a chrome-extension:// URL of different extension`); the extension's
`javascript_tool` works only flakily and cannot read canvas content anyway.

**Server-side render** (e.g. Figma MCP `get_screenshot`, which renders a node by ID) is a valid
*complement* — reliable, no UI driving — but the user may prefer live desktop capture for
interactive exploration. It is not a downgrade in fidelity (same renderer), just a different
delivery path.

Project-specific procedure for this workspace's Figma work:
`rh-platform-agentbuild/docs/figma-acquisition-method.md`.

## Multi-User Awareness

| Resource | Scope | Users with access |
|----------|-------|-------------------|
| `~/.claude/settings.json` (hooks, telemetry, statusline) | Per-user | Current user only |
| `~/.claude/agents/` (pdf-extractor, excel-writer, etc.) | Per-user | Current user only |
| `<workspace>/.claude/rules/` (this file) | Shared | All workspace users |
| `<workspace>/.claude/settings.json` (permissions) | Shared | All workspace users |

- If hooks or agents are unavailable, operate without them — do not error
- Never assume per-user resources exist for all users

## Shell Rules

- All environments use bash as the shell on Windows
- PowerShell: wrap as `powershell.exe -Command "..."` or `powershell.exe -NoProfile -Command "..."`
- Use forward slashes in paths (bash on Windows normalizes them)
- Use absolute paths for cross-session reliability
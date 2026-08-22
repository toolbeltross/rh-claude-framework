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
| Read single PDF | `Read` | — | ✅ Working again as of 2026-08-07 (verified by rendering a real PDF page). `Read` shells out to `pdftoppm`; if it ever reports *"pdftoppm is not installed"* again, see the RESOLVED block below — that message has three possible causes and reinstalling fixes only one. **Full route comparison — 8 routes ranked by job, with per-route fidelity evidence: [`docs/acquisition/pdf-acquisition-method.md`](../../docs/acquisition/pdf-acquisition-method.md).** Corrected 2026-08-07 by direct test: `mcp__desktop-commander__read_file` is the **best text route** (not merely a fallback — it preserves `×` `↔` `·` and reconstructs heading levels, and needs no external binary), and `pdf-reader` is **sandboxed to the session CWD** — it rejects absolute paths AND `../` traversal, so it cannot read a PDF outside the current project at all |
| Read `.docx` / `.xlsx` | `mcp__desktop-commander__read_file` | `Read` | Always — built-in `Read` rejects these as binary. DC returns a paragraph/table outline for `.docx` |
| Read file > 800 lines | subagent with oversight protocol | direct `Read` in main context | Never — always use subagent for files this large |

## Desktop-Only Tools (never attempt from CLI or VS Code)

These MCP tools exist ONLY in the Claude Code Desktop app:
- `mcp__claude-in-chrome__*` (browser automation) — **name corrected 2026-08-07**: this rule previously said `mcp__Claude_in_Chrome__*` (capitalized). The capitalized form does not resolve.
- `mcp__Claude_Browser__*` (in-app Browser pane + dev-server preview) — **absorbed the former `mcp__Claude_Preview__*`**, which no longer exists under any name. `preview_start` / `preview_stop` / `preview_list` / `preview_logs` now live here.
- `mcp__c24bbf0a-*__slack_*` (Slack messaging)
- `mcp__computer-use__*` (OS-level desktop control; native apps get full tier, browsers read-only)
- `mcp__scheduled-tasks__*` (recurring task runner)
- `mcp__mcp-registry__*` (connector discovery)

> **Namespace drift warning.** Tool names in this rule were written 2026-04-25 and had silently diverged from the live namespace by 2026-08-07. Before trusting any `mcp__*` name here, confirm it against the session's actual tool inventory — a name that doesn't resolve is a rename, not an outage.

If environment is `cli` or `vscode`, do NOT call these tools.

## Visual Verification (rewritten 2026-04-25 after Playwright MCP benchmark)

Anthropic's own best-practices doc says: *"Include tests, screenshots, or expected outputs so Claude can check itself. This is the single highest-leverage thing you can do."* — the goal is **digestible verification when needed**. All pipelines and surfaces below tested working on this machine (Windows 11, bash on Windows, Claude Code Desktop) on 2026-04-25.

> **Re-verified 2026-08-07.** Playwright still passes end-to-end (navigate / ARIA snapshot / `browser_evaluate` computed style / element screenshot — `innerWidth` reported 1280, not the `0×0` pathology). Three things had drifted: the `mcp__Claude_Preview__*` and `mcp__Claude_in_Chrome__*` namespaces (see above), and an OCR/PDF tooling outage that turned out to have two different causes (below, now **resolved**). Pillow 12.2.0, node, npx remain present and on PATH.

> ### ✅ RESOLVED 2026-08-07 — and the diagnosis took three tries
> All three tools now resolve on PATH and execute, confirmed in a **fresh session** after a full app relaunch:
>
> | Tool | Location on PATH | Verified |
> |---|---|---|
> | ImageMagick | `C:\Program Files\ImageMagick-7.1.2-Q16-HDRI` | `7.1.2-29 Q16-HDRI`, exit 0 |
> | Tesseract | `C:\Program Files\Tesseract-OCR` | `v5.4.0.20240606`, exit 0 |
> | poppler | `…\WinGet\Packages\oschwartz10612.Poppler_…\poppler-25.07.0\Library\bin` | `pdftoppm 25.07.0`, exit 0 |
>
> **Built-in `Read` opens PDFs again** — verified by rendering page 1 of a real PDF, not just by resolving the binary.
>
> **Three distinct failure classes produce the identical symptom.** Diagnose in this order:
>
> | Class | Test | Fix |
> |---|---|---|
> | 1. Genuinely missing | `winget list <pkg>` | Install it |
> | 2. Installed, off PATH | Binary exists under `C:\Program Files\` or `…\WinGet\Packages\` but `which` fails | Add its dir to the **user** PATH |
> | 3. **Stale process environment** | PATH entry is present in the registry, the binary is there, yet `which` *still* fails in a running session | **Fully quit and relaunch the app.** A new session/tab is NOT enough |
>
> ImageMagick and Tesseract were class 2. **poppler was class 3** — its WinGet\Packages path had been on the user PATH the whole time; the session predated the entry, so `Read` reported "pdftoppm is not installed" while the tool sat there working. Class 3 is the trap: every surface reports missing software, and reinstalling returns "already installed."
>
> Two gotchas worth keeping: poppler resolves from `WinGet\Packages\…`, **not** from `WinGet\Links` (that shim dir is empty and not on PATH); and its entry is **version-pinned** (`poppler-25.07.0`), so a future upgrade will silently re-break PDF reads with the same misleading symptom.

### Strengths / weaknesses matrix — pick the right tool for the job

| Tool | DOM / text | Computed style | Element screenshot | Full-page screenshot | Console errors | OCR / pixel parsing | Notes |
|---|---|---|---|---|---|---|---|
| **`mcp__playwright__*`** | ✅ ARIA tree YAML auto-saved on every `browser_navigate` | ✅ `browser_evaluate` | ✅ `browser_take_screenshot` with `ref=eN` from snapshot | ✅ `fullPage: true` | ✅ auto-saved on navigate | n/a | **No timeouts encountered. Primary surface.** |
| `mcp__claude-in-chrome__*` | ✅ `read_page`, `find`, `javascript_tool` | ✅ `javascript_tool` | ❌ CDP timeout 30s | ❌ same | ✅ `read_console_messages` | n/a | DOM tools fine; **`computer screenshot` action broken**. Note lowercase name |
| `mcp__Claude_Browser__*` | ✅ `read_page`, `find`, `get_page_text` | ✅ `javascript_tool` | ⚠️ fails **5s** when pane hidden | ⚠️ same | ✅ `read_console_messages` | n/a | Successor to `Claude_Preview`. Screenshot error is now actionable: *"the Browser pane is not displayed… Display the pane and retry."* `navigate` **blocks localhost**; use `preview_start` with an origin-only URL instead |
| ~~`mcp__Claude_Preview__*`~~ | — | — | — | — | — | — | **Tool no longer exists** (2026-08-07). Folded into `mcp__Claude_Browser__*`. Retained only so the old name is recognizable |
| Playwright CLI via Bash | (HTML source only) | n/a | n/a (no element refs) | ✅ `npx playwright screenshot URL out.png` | n/a | n/a | Headless, no MCP dependency — last-resort capture |
| `Bash(curl …)` + `Grep` | source-text only | n/a | n/a | n/a | n/a | n/a | Confirms a server response or static text |
| Pillow (Python) | n/a | n/a | post-process | post-process | n/a | crop / resize / contrast | Color-preserved preview |
| ImageMagick CLI | n/a | n/a | post-process | post-process | n/a | grayscale + contrast-stretch + sharpen | ✅ On PATH (7.1.2-29, verified 2026-08-07). Best for OCR-prep — halves file size vs Pillow color |
| Tesseract OCR | n/a | n/a | n/a | n/a | n/a | text-from-pixels | ✅ On PATH (v5.4.0, verified 2026-08-07). Good on prose; **mangles styled chip pills + code-with-bg** — go DOM instead |
| `mcp__computer-use__screenshot` | n/a | n/a | n/a (full screen) | n/a (full screen) | n/a | n/a | OS-level capture; untested for this workflow |

### Surface ranking — which to reach for first

| Rank | Surface | Use for | Why this rank |
|---|---|---|---|
| 1 | **`mcp__playwright__*`** | DEFAULT. ARIA accessibility-tree on every navigate; computed style via evaluate; element-scoped screenshots that succeed; auto console-log capture | Verified deterministic 2026-04-25 across navigate / snapshot / evaluate / element-screenshot — only surface that does ALL of those without a CDP timeout |
| 2 | `mcp__claude-in-chrome__*` (DOM/text only) | When already mid-Chrome flow; secondary computed-style queries | DOM tools fine, but `computer screenshot` action is broken — don't bother with screenshots here |
| 3 | Playwright CLI via Bash | Headless URL→PNG capture independent of any MCP layer | Useful for non-interactive tests / batch captures / when MCPs are misbehaving |
| 4 | `Bash(curl …)` + `Grep` / `Read` | Source-level "does the served file contain string X" | Cheapest first-pass before involving any renderer at all |
| 5 | `mcp__Claude_Browser__*` text tools | Last-resort DOM reads | `read_page` / `get_page_text` / `javascript_tool` work. Screenshot fails in 5s while the pane is hidden. Replaces the retired `mcp__Claude_Preview__*` |

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
| ~~`mcp__Claude_Preview__preview_screenshot`~~ | **Moot — the whole `Claude_Preview` server no longer exists** (2026-08-07). Historical: 30s timeout, `preview_eval` reported `viewport: 0×0` | Anthropic Issue #30122 (closed "not planned") |
| `mcp__claude-in-chrome__computer` `screenshot` action | Times out: *"CDP sendCommand 'Page.captureScreenshot' timed out after 30000ms on tab N. The renderer may be frozen or unresponsive."* | Reproduced 2026-04-25 (name corrected to lowercase 2026-08-07) |
| `mcp__Claude_Browser__computer` `screenshot` action | Fails in **5s**, not 30: *"the Browser pane is not displayed, so the page is not compositing frames. Display the pane and retry."* | Reproduced 2026-08-07 |

If you need a pixel image of a rendered page, **use the Playwright CLI pipeline below instead**.

> **The `Claude_Browser` failure is different in kind.** It is a 5s failure with a stated, user-actionable remedy (display the pane) — not the 30s unfixable hang the retry-guard was calibrated against. Escalating away from it instantly costs more than reading the error. Treat "never retry" as applying to the 30s CDP class, not this one.

### Tested pipeline — URL to digestible image

All paths verified working 2026-04-25. **Re-confirmed 2026-08-07** — every step runs as written: `magick` and `tesseract` are back on PATH, so the bare command names resolve. Step 1 (Playwright CLI) and step 2a (Pillow 12.2.0) unchanged.

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
| ImageMagick (optional) | Grayscale + sharpen for OCR prep | ✅ 7.1.2-29, on PATH |
| Tesseract (optional) | OCR text extraction | ✅ v5.4.0, on PATH |
| poppler (`pdftoppm`) | Lets built-in `Read` open PDFs | ✅ 25.07.0, on PATH (from `WinGet\Packages\…`, not `WinGet\Links`) |

> **Do not diagnose any of these as "not installed" on a bare `command not found`.** `winget install` returns "already installed" for all three. That message has three causes — missing, off-PATH, and stale-process-environment — and only the first is fixed by installing. Check `C:\Program Files\` and `…\WinGet\Packages\`, then check whether the running session predates the PATH entry, before concluding anything is absent. Full decision table in the RESOLVED block above.
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
- Don't reach for Chrome MCP `computer screenshot` on this machine — it reproducibly times out after 30s. (`preview_screenshot` is gone entirely; its successor `mcp__Claude_Browser__computer` fails in 5s with a readable reason — see the BROKEN table.)
- Don't assume a non-resolving `mcp__*` name means an outage — check the live tool inventory first. Three names in this rule had been renamed out from under it between 2026-04-25 and 2026-08-07.
- Don't let Playwright write artifacts into a project dir. Every `browser_navigate` auto-drops `.playwright-mcp/` (ARIA snapshot + console log) into CWD, and **that path is not configurable** — see `rh-throwaway-artifacts.md`.
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

**Full verified procedure — route comparison, why the browser route fails, desktop-app method,
cross-MCP conflict resolution:** [`docs/acquisition/figma-acquisition-method.md`](../../docs/acquisition/figma-acquisition-method.md)
(workspace-level, so it is reachable from any session). Copied 2026-08-07 from the project-scoped original at
`rh-platform-agentbuild/docs/figma-acquisition-method.md`, which remains authoritative for
ToolBelt-specific facts (fileKeys, PAT state, inventory counts).

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
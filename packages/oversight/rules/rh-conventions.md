---
description: "Workspace file and project conventions"
keywords: [_index.md, CLAUDE.md, xlwings, openpyxl, absolute path, relative path, session state, MASTER_, CONSOLIDATED_, checkbox tracking]
severity: warn
---

# Conventions

- Every project folder gets a CLAUDE.md
- Use _index.md (YAML frontmatter + markdown table) for folder manifests
- xlwings for ALL xlsx writes (openpyxl destroys charts/comments; MCP excel server has known bugs)
- Session state files: current facts only, archive history when > 100 lines
- All plans follow checkbox tracking for session recovery
- ALWAYS use absolute paths in Edit and Write tool calls — relative paths may silently no-op. Provide the full absolute path in all output to the user — never relative paths or bare filenames alone
- Any file named `MASTER_*.md` or `*_CONSOLIDATED.md` must include a Source Registry section with verification tokens. See `completion-standards.md`.
- Where docs / data / temp / project-tracking files belong (and the requirement that each project's CLAUDE.md declare its own "File Placement" section) is codified in `rh-doc-placement.md` — the home for placement conventions.

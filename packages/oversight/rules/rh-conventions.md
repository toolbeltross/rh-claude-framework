---
description: "Workspace file and project conventions"
---

# Conventions

- Every project folder gets a CLAUDE.md
- Use _index.md (YAML frontmatter + markdown table) for folder manifests
- xlwings for ALL xlsx writes (openpyxl destroys charts/comments; MCP excel server has known bugs)
- Session state files: current facts only, archive history when > 100 lines
- All plans follow checkbox tracking for session recovery
- ALWAYS use absolute paths in Edit and Write tool calls — relative paths may silently no-op. Provide the full absolute path in all output to the user — never relative paths or bare filenames alone
- Any file named `MASTER_*.md` or `*_CONSOLIDATED.md` must include a Source Registry section with verification tokens. See `completion-standards.md`.

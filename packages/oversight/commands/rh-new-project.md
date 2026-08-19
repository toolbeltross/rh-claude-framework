# /new-project

Scaffold a new project folder with standard structure.

## Usage

```
/new-project [domain] [project_name]
```

## Parameters

- **domain**: Project domain/category
  - `Financial` — Financial projects (accounting, investments, proposals)
  - `Code` — Software development projects
  - `Personal` — Personal projects (learning, life admin)
  - `Business` — Business operations (planning, processes, docs)
  - `Shared` — Shared team projects
  - `Research` — Research and analysis projects
- **project_name**: Human-readable project name (alphanumeric + hyphens)

## Process

1. **Validate Inputs**: Check that domain is valid and project_name is non-empty
2. **Create Folder**: Create directory at `Workspace/[domain]/[project_name]/`
3. **Create .claude Subdir**: Create `.claude/` directory with `agents/`, `commands/`, `plans/` subdirs
4. **Initialize CLAUDE.md**:
   - Project title and description (user fills in)
   - Main working file(s) (user specifies)
   - Ignored directories (default: Taxes/, Archive/)
   - **File Placement** section (per `.claude/rules/rh-doc-placement.md` — where docs/data/temp/project-tracking artifacts belong; extend the global categories with any project-specific layout choices)
   - Template for MCP Servers and custom agents/commands
5. **Initialize .gitignore** (per `.claude/rules/rh-throwaway-artifacts.md`):
   - `tmp/` — disposable artifacts (screenshots, API dumps, scratch outputs)
   - Common project excludes (`.env`, `node_modules/` for code projects; user confirms per project type)
6. **Initialize tmp/.gitkeep**: empty file so the throwaway directory exists but stays out of git
7. **Initialize _index.md**:
   - YAML frontmatter with `created_date`, `last_updated`, `domain`, `project_name`
   - Markdown table with columns: Filename, Key Data, Status, Notes
   - Row 1: "Add documents to this project directory and reference them here"
8. **Report**: Folder created, files initialized, next steps

## Directory Structure Created

```
Workspace/
├── [domain]/
│   └── [project_name]/
│       ├── .claude/
│       │   ├── agents/
│       │   ├── commands/
│       │   ├── plans/
│       │   └── settings.json
│       ├── tmp/
│       │   └── .gitkeep
│       ├── .gitignore
│       ├── _index.md
│       ├── CLAUDE.md
│       └── SESSION_STATE.md (empty, ready for use)
```

## Example Invocations

```
/new-project Financial "Real Estate Analysis"
/new-project Code "Python Data Pipeline"
/new-project Personal "Reading List"
/new-project Business "Quarterly Planning"
```

## CLAUDE.md Template

The generated CLAUDE.md includes:
- Project title and description fields
- Main working file(s) section
- Ignored Directories section (pre-filled with Taxes/, Archive/)
- **File Placement** section — declares where docs / data / temp / project-tracking files live for this project, extending the global categories in `.claude/rules/rh-doc-placement.md`. Default seed:
  - Configuration / entry: project root
  - Documentation: `docs/`
  - Data (committed): `data/` (if applicable)
  - Data (generated) / temp / throwaway: `tmp/` (gitignored)
  - Project tracking: plans + `DECISIONS.md` + `SESSION_STATE.md` at project root
- Plan Standards section (reference to workspace standards)
- Infrastructure section (template for MCP servers and custom agents)

User customizes the description, specifies which workspace-level agents will be used, and adjusts File Placement to match the project's actual layout (monorepo vs flat, whether `data/` is committed, etc.).

## .gitignore Template

Seed with (per `.claude/rules/rh-throwaway-artifacts.md`):

```
# Local scratch / throwaway artifacts (screenshots, API dumps, one-off outputs)
tmp/

# Secrets — never commit
.env
.env.local
```

For code projects, add framework-specific excludes (`node_modules/`, `dist/`, `__pycache__/`, etc.) at scaffolding time.

## Error Handling

- If domain is invalid, list valid domains and ask for correction
- If folder already exists, ask whether to overwrite or use different project_name
- If folder creation fails (permissions), report the error

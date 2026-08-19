# /status

Cross-project status summary.

## Usage

```
/status [domain]
```

## Parameters

- **domain** (optional): Limit report to single domain
  - Valid values: `Financial`, `Code`, `Personal`, `Business`, `Shared`, `Research`
  - If omitted, show all domains

## Process

1. **Enumerate Projects**: For each folder in the target domain(s):
   a. Read CLAUDE.md for project description
   b. Read SESSION_STATE.md (if exists) for current state, phase, last_work_date
   c. Read _index.md (if exists) for file status counts
2. **Calculate Metrics**:
   - Total files in project
   - Unread files (⬜)
   - Files in review (⚠️)
   - Completed files (✅)
   - Files with errors (❌)
   - Days since last update (last_updated in _index.md)
3. **Format Summary Table**:
   ```
   | Project | Domain | Status | Files | Unread | Review | Complete | Last Updated |
   |----|-------|--------|-------|--------|--------|----------|---|
   ```
4. **Flag Stale Projects**: If last_updated > 7 days ago, mark with ⏰
5. **Report**: Formatted table, summary statistics, any high-priority items

## Status Indicators

- `🟢 active` — Updated within last 7 days
- `🟡 stale` — Not updated for 7-30 days (⏰)
- `🔴 dormant` — Not updated for > 30 days
- `⚙️ in-progress` — SESSION_STATE indicates active work

## Example Invocations

```
# Show all projects across all domains
/status

# Show Financial domain projects only
/status Financial

# Show all projects with stale data
/status | grep ⏰
```

## Metrics Returned

For each project:
- **Project Name**: From CLAUDE.md
- **Domain**: Category (Financial, Code, etc.)
- **Status**: 🟢 active / 🟡 stale / 🔴 dormant / ⚙️ in-progress
- **Total Files**: Count from _index.md table
- **Unread**: Count of ⬜ rows
- **In Review**: Count of ⚠️ rows
- **Complete**: Count of ✅ rows
- **Errors**: Count of ❌ rows
- **Last Updated**: Date from _index.md YAML frontmatter
- **Last Work Date**: Date from SESSION_STATE.md (if exists)
- **Current Phase**: From SESSION_STATE.md (if exists)

## Error Handling

- If CLAUDE.md is missing, report "Missing CLAUDE.md" for that project
- If _index.md is missing, report "No document index" but continue
- If no projects found in a domain, report "No projects found in [domain]"
- If workspace root is not accessible, report error and suggest checking path

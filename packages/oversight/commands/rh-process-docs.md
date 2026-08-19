# /process-docs

Process all unread documents in a target folder and update tracking.

## Usage

```
/process-docs [folder_path] [spreadsheet_path] [sheet_name] [extraction_type]
```

## Parameters

- **folder_path** (required): Path to folder containing _index.md and unread documents
- **spreadsheet_path** (optional): Path to .xlsx file for spreadsheet updates
- **sheet_name** (optional): Target sheet in the spreadsheet (e.g., "ASSETS", "Data")
- **extraction_type** (optional): One of "financial", "legal", "general". Default inferred from document type.

## Process

1. **Read Index**: Load the _index.md from the target folder
2. **Identify Unread**: Find all rows with status `⬜ unread`
3. **Extract Data**: For each unread file:
   - Spawn a Task with pdf-extractor subagent (up to 3 in parallel)
   - Collect structured JSON results
4. **Update Index**: For each processed file:
   - Call index-updater subagent to update status and key_data
5. **Queue Spreadsheet Updates** (if spreadsheet_path provided):
   - Scan extracted data for relevant updates
   - Build an update array: `[{row, col, value, old_value_expected, note}]`
6. **Apply Spreadsheet Updates** (if queue not empty):
   - Call spreadsheet-writer subagent in one batch
   - Verify all writes
7. **Report Summary**:
   - Files processed count
   - Files with errors (if any)
   - Spreadsheet changes applied (if any)
   - Update timestamps

## Example Invocations

```
# Quick process: just extract and update index
/process-docs "C:\Projects\MyProject\documents"

# With spreadsheet updates
/process-docs "C:\Projects\MyProject\documents" \
  "C:\Projects\MyProject\main.xlsx" "ASSETS"

# Specify extraction type
/process-docs "C:\Projects\MyProject\documents" \
  "C:\Projects\MyProject\main.xlsx" "ASSETS" "financial"
```

## Error Handling

- If _index.md is missing, report error and ask for folder confirmation
- If no unread files found, report "All files already processed" and exit
- If pdf-extractor fails on a file, log the error, update status to `⚠️ review`, and continue
- If spreadsheet_path is invalid, skip spreadsheet updates but continue with index updates
- If spreadsheet-writer fails, report the error and ask whether to retry

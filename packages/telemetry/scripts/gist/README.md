# Claude Code Statusline

Rich ANSI statusline for Claude Code — zero dependencies, single file.

## Install

```bash
curl -o ~/.claude/statusline.js https://gist.githubusercontent.com/RAW_URL/statusline.js
```

Then add to `~/.claude/settings.json`:
```json
{ "statusLine": { "type": "command", "command": "node ~/.claude/statusline.js" } }
```

## What you get

**Line 1:** Model | Cost | Duration | Git branch | Directory | Lines changed

**Line 2:** Context window bar (tri-color) + token usage + cache hit ratio

## Optional: Telemetry enrichment

Set `RH_TELEMETRY_URL=http://localhost:7890` to get a 3rd line with turn count, tools fired, and active agents (requires [rh-telemetry](https://github.com/toolbeltross/rh-telemetry) server).
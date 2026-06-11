---
name: session
description: Show what's active in the current session — hooks, rules, agents, skills, memories, MCP servers, model, and CLAUDE.md chain
argument-hint: ""
---

Here is the current session inventory from the filesystem:

```
!`node "$HOME/.claude/skills/rh-session/scripts/session-inventory.js"`
```

Now supplement the filesystem inventory above with runtime information that only you (Claude) can see from the current session context:

1. **Model**: Report the exact model name and ID you are running as
2. **MCP Servers**: List all MCP servers that are connected in this session (from your system context)
3. **Deferred Tools**: Note how many deferred/MCP tools are available (approximate count from your tool list)
4. **Environment**: Report `$CLAUDE_CODE_ENTRYPOINT` if the script showed "(not set)"

Present everything as a single clean inventory. Use the filesystem data as-is (it's already formatted), then append the runtime sections in the same style. Keep it concise — this is a reference dump, not a narrative.

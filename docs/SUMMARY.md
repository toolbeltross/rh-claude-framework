# rh-claude-framework — Two-Page Summary

## What this is

A portable enforcement + observability framework for Claude Code, built from 18 months of production usage across a multi-project workspace. It addresses the gap between "Claude Code is capable" and "I can reliably verify that it did what it said."

The framework installs as a single CLI command and wires itself into Claude Code's hook system. After install, enforcement is automatic — it doesn't depend on the user writing better prompts or remembering to follow rules.

---

## The core problem

Claude Code sessions produce outputs that are hard to verify:

- **Silent truncation.** The `Read` tool caps at ~10K tokens (~400 lines). Files silently return partial content. Claude calls them "incorporated."
- **Unverifiable subagents.** When Claude dispatches a subagent, the subagent runs in a fresh context with no inherited oversight requirements. It returns output Claude treats as complete.
- **No session memory.** Insights, recommendations, and learnings surface during a session and disappear when it closes.
- **Enforcement drift.** Rules in `CLAUDE.md` work when Claude notices them. They stop working silently when the relevant rule isn't top-of-mind at the moment of decision.

These failure modes compound: a session that reads three source files partially, runs a subagent with no completeness requirements, and closes without capturing any learnings has low-quality outputs that look correct from the outside.

---

## How the framework addresses each failure mode

| Failure mode | Mechanism | How it works |
|---|---|---|
| Silent truncation | `PostToolUse:Read` audit hook | Logs every Read; warns when line count suggests truncation |
| Unverified synthesis | `PreToolUse:Write` consolidation guard | Blocks writes to `MASTER_*` / `*_CONSOLIDATED.md` unless a Source Registry with verification tokens is present |
| Subagent without requirements | `PreToolUse:Agent` auto-inject | Appends canonical oversight block (completeness proof, context report, batch overflow rule) to any Agent prompt missing these elements |
| Session value lost at close | `/rh-quit` scribe skill | Single-agent multiscope drain: recommendations → `recommendations.md`, cleanup → `cleanup.md`, learnings → `~/.claude/memory-shared/` |
| Enforcement drift | Supervisor preload + Stop review | SessionStart injects 3-rule self-check as `additionalContext`; Stop pipeline runs a supervisory review before the session closes |
| Rejection reasons lost | `Stop` capture hook | Appends Layer 3a rejection reasons to `supervisory-log.md` for cross-session analysis |

---

## 10 reusable patterns

The framework is designed as a collection of named patterns, not a monolithic system. Each pattern closes a specific failure mode and can be adopted independently. From [`docs/PATTERNS.md`](PATTERNS.md):

1. **Guard** — `PreToolUse` blocks on missing required structure (fail-open + telemetry emit)
2. **Auto-Inject** — `PreToolUse:Agent` mutates prompts via `updatedInput` without blocking
3. **Audit** — `PostToolUse` logs + non-blocking warns on truncation and subagent failures
4. **Multi-Stage Stop Pipeline** — ordered Stop hooks: extract → supervisory review → capture
5. **Verification Token** — last-line verbatim as EOF proof; Source Registry in every consolidation doc
6. **Scribe** — end-of-session multiscope drain to persistent memory files
7. **Atomic Writer** — O_EXCL lockfile with jitter + stale recovery for concurrent hook writes
8. **Supervisor Preload** — `SessionStart` injects condensed 3-rule self-check as `additionalContext`
9. **Self-Test** — daily smoke test runs each hook against known-violating fixtures
10. **Zero Hardcoded Paths** — env var > config file > CWD auto-detect; no user-specific strings in code

---

## Scale and test coverage

The framework is a 6-package npm monorepo with 343 passing tests across the enforcement, CLI, and output packages:

| Package | Tests | What's covered |
|---|---|---|
| `packages/oversight` | 177 | All 25 hook scripts, agents, rules, verification-token logic, scribe staging, supervisor sweep |
| `packages/cli` | 54 | Init/merge/reset, settings validate/show/diff/merge/backup/restore, cross-package contract |
| `packages/output` | 112 | HTML renderer, scribe table writer, learnings writer, auto-prune, daily-regen, 16-way concurrent stress |

Self-test: `rh-oversight self-test` → `37/37 hard passed`. This runs each enforcement hook against a known-violating fixture and verifies expected block/allow/mutate behavior.

---

## What the framework is not

- **Not a prompt library.** It doesn't improve the quality of prompts the user writes. It enforces structural requirements on outputs and subagent dispatches.
- **Not a replacement for CLAUDE.md rules.** Rules tell Claude what to do. The framework enforces the rules structurally when Claude misses them.
- **Not opinionated about the user's workflow.** The framework is additive: it installs hooks additively (preserving existing entries), ships agent definitions that don't conflict with user-defined agents, and provides skills the user invokes explicitly. Nothing runs automatically without the user's participation.

---

## Getting started

```bash
git clone https://github.com/toolbeltross/rh-claude-framework
cd rh-claude-framework && npm install
node packages/cli/bin/rh-oversight.js init --workspace /path/to/your/workspace
node packages/cli/bin/rh-oversight.js self-test
```

Full documentation: [`docs/PATTERNS.md`](PATTERNS.md) · [`README.md`](../README.md) · [`PROGRESS.md`](../PROGRESS.md)

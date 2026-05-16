# Claude Code Oversight Patterns

Reusable patterns for building reliable, auditable Claude Code setups. Each pattern addresses a concrete failure mode observed in production Claude Code usage. The patterns are implemented in this framework but described here independently so you can adopt them individually.

---

## Table of Contents

1. [The Guard Pattern](#1-the-guard-pattern)
2. [The Auto-Inject Pattern](#2-the-auto-inject-pattern)
3. [The Audit Pattern](#3-the-audit-pattern)
4. [The Multi-Stage Stop Pipeline](#4-the-multi-stage-stop-pipeline)
5. [The Verification Token Pattern](#5-the-verification-token-pattern)
6. [The Scribe Pattern](#6-the-scribe-pattern)
7. [The Atomic Writer Pattern](#7-the-atomic-writer-pattern)
8. [The Supervisor Preload Pattern](#8-the-supervisor-preload-pattern)
9. [The Self-Test Pattern](#9-the-self-test-pattern)
10. [The Zero-Hardcoded-Paths Pattern](#10-the-zero-hardcoded-paths-pattern)

---

## 1. The Guard Pattern

**Hook:** `PreToolUse`

**Problem:** Claude can claim to have verified work, written a correct document, or completed a task when the output lacks required structure. These gaps only surface later — often after the session ends — when a downstream consumer finds the output incomplete or unverifiable.

**Solution:** A `PreToolUse` hook reads the tool input before the tool fires and blocks if required structure is missing. The block message surfaces in Claude's context so it self-corrects in the same turn.

**Example — consolidation documents must have a Source Registry:**

```js
// PreToolUse:Write hook
const isConsolidation = /MASTER_|CONSOLIDATED/i.test(filename);
const hasRegistry     = /Source Registry/i.test(content);
const hasTokens       = /verification token|last line/i.test(content);

if (isConsolidation && (!hasRegistry || !hasTokens)) {
  process.stdout.write(JSON.stringify({
    action: 'block',
    message: 'Consolidation document rejected: missing Source Registry with verification tokens.'
  }));
  process.exit(0);
}
```

**Key design choices:**
- **Fail-open on infrastructure errors.** If the hook itself crashes (malformed stdin, missing env), allow the tool to proceed rather than blocking the whole session. Fail-CLOSED turns hook bugs into user-visible session failures.
- **Emit to telemetry on every block.** Without telemetry, the supervisor only learns about blocks from session transcripts. A fire-and-forget POST to the telemetry server on each block creates a persistent record across sessions.
- **Target specific filenames, not all writes.** Broad guards create noise and slow sessions. Narrow pattern-matching (e.g., `MASTER_*` filenames) keeps the guard surgical.

**Other applications:** block `git push` to protected branches, block writes to files with credentials patterns, require a test-run verification line before allowing certain file edits.

---

## 2. The Auto-Inject Pattern

**Hook:** `PreToolUse` (on `Agent` tool)

**Problem:** When Claude dispatches a subagent, the subagent operates in a fresh context and doesn't inherit the parent's oversight requirements. The result is subagent outputs that can't be verified: no proof of completeness, no context-pressure reporting, no batch-overflow guard. The parent silently passes these through.

**Solution:** A `PreToolUse` hook on the `Agent` tool scans the prompt for required elements and, if missing, appends a canonical block via `updatedInput`. The subagent sees the requirements as part of its own prompt.

```js
// PreToolUse:Agent hook
const REQUIRED = [
  /verification token|last line/i,   // element 1: proof of completeness
  /context.*usage|compaction/i,      // element 2: self-reported telemetry
  /batch overflow|stop.*first item/i // element 3: resource bound
];

const missing = REQUIRED.filter(r => !r.test(prompt));
if (missing.length > 0) {
  // Return updatedInput to mutate the prompt without blocking
  process.stdout.write(JSON.stringify({
    action: 'allow',
    updatedInput: { ...toolInput, prompt: prompt + CANONICAL_BLOCK }
  }));
}
```

**Key design choices:**
- **Allow-with-mutation, not block.** Blocking Agent dispatches stops work entirely. `updatedInput` lets the dispatch proceed with the corrected prompt — the user never sees the intervention.
- **Post an `oversight_auto_inject` event to telemetry on every injection.** This lets you track which task types require the most correction. High injection rates signal that the user's base prompts need improvement.
- **Use a literal canonical block, not a generated summary.** The canonical block is the exact text from your oversight rule. Generating a paraphrase risks drift between the injected requirements and what the result-guard later validates.

**Why this beats rule-only approaches:** Rules tell Claude what to do; Auto-Inject ensures it happens even when Claude doesn't notice the rule applies. It's the difference between a style guide and a linter.

---

## 3. The Audit Pattern

**Hook:** `PostToolUse`

**Problem:** `Read` calls silently truncate large files at ~10K tokens (~400 lines). Claude may then incorporate partial content and describe the file as "read" or "incorporated" — a silent correctness failure with no diagnostic trace.

**Solution:** A `PostToolUse` hook on `Read` logs every call and warns when the response length suggests truncation.

```js
// PostToolUse:Read hook
const linesReturned = (output.match(/\n/g) || []).length;
const FILE_THRESHOLD = 800; // lines — from rh-read-integrity.md

if (linesReturned >= FILE_THRESHOLD) {
  console.warn(
    `[read-audit] Large file read: ${filePath} (${linesReturned} lines returned). ` +
    `Verify completeness — files >800 lines should be dispatched to a subagent.`
  );
}

fs.appendFileSync(SESSION_READS_LOG, `${timestamp}\t${filePath}\t${linesReturned}\n`);
```

**Key design choices:**
- **Log to a session file, not just stderr.** `~/.claude/session-reads.log` accumulates across the session and is available for the supervisor to review. Stderr is lost between turns.
- **Non-blocking warning, not a block.** Auditing is observational. Blocking on file size creates friction for legitimate large-file operations (grep, head, offset reads). Warn; let the user decide.
- **Apply the same hook to PDF reads.** `mcp__pdf-reader__read_pdf` is a distinct tool with its own `PostToolUse` event but the same truncation risk.

**Related: the Agent result-guard.** A parallel `PostToolUse:Agent` hook scans subagent results for failure signals ("WebSearch denied", "permission error", "no results") and emits a warning so Claude acknowledges degradation rather than proceeding silently.

---

## 4. The Multi-Stage Stop Pipeline

**Hook:** `Stop` (multiple entries, ordered)

**Problem:** The `Stop` event is the last chance to extract session value before the turn closes. But a single Stop hook trying to do everything (extract recommendations, verify work, capture learnings, log to telemetry) becomes slow and brittle. And a supervisory review prompt needs to fire *after* extraction, not before.

**Solution:** Chain multiple Stop hooks in explicit order. Each stage is a separate hook entry; they execute in settings.json order.

```json
"Stop": [
  { "hooks": [{ "type": "command", "command": "node ~/.claude/scripts/rh-scribe-prefilter.js" }] },
  { "hooks": [{ "type": "prompt", "prompt": "...<3-rule self-check>..." }] },
  { "hooks": [{ "type": "command", "command": "node ~/.claude/scripts/rh-layer3a-capture.js" }] }
]
```

**Stage 1 — scribe-prefilter (command hook):**
Runs regex extraction over the transcript tail synchronously. Appends matched recommendations, cleanup items, and learnings markers to their respective files using atomic writes. Fast (~50ms); extracting inline because the transcript bytes are available right now.

**Stage 2 — supervisory review (prompt hook):**
Injects a 3-rule self-check as `additionalContext`. Claude evaluates its own turn against the rules before the session closes. Rejections are visible in the transcript as Layer 3a output.

**Stage 3 — layer3a-capture (command hook):**
Reads the supervisory review's output from the transcript and appends rejection reasons to `supervisory-log.md`. Without this, rejections are only visible in the transcript and lost after the session ends.

**Key design choices:**
- **Stage ordering matters.** The prefilter must run before the supervisory prompt to avoid the prompt consuming context that the prefilter needed. The capture must run after so there's a rejection to capture.
- **Stage 1 is fast and always succeeds; Stage 2 can reject.** Don't make Stage 2 depend on Stage 1 succeeding. Isolation between stages makes failure analysis cleaner.
- **Stage 3 is observational — it never blocks.** Even if the capture fails (log write error, parse error), the session closes. Supervisory logging is not load-bearing for session correctness.

---

## 5. The Verification Token Pattern

**Pattern:** In rules, agents, and prompts

**Problem:** The `Read` tool truncates silently. When Claude incorporates a source file into a consolidated document, there's no way to verify after the fact whether the full file was read or only the first N lines. Calling a file "incorporated" is a claim about completeness that can't be externally audited.

**Solution:** Require a *verification token* for every source in any consolidation task. The token is the **literal last line** of the file, plus total line count and the range actually read.

```
Source Registry:
| File | Lines | Read | Token (last line verbatim) |
|------|-------|------|---------------------------|
| config.js | 87 | 1-87 | `module.exports = { config };` |
| README.md | 110 | 1-110 | `MIT` |
```

**Why the last line, not a hash?** The last line is human-readable and auditable without tooling. More importantly, it proves the Read reached EOF — a first-line token proves only that the file was opened, not that truncation didn't occur at line 400.

**Enforcement layers:**
- The consolidation-guard (Pattern 1) blocks `Write` on MASTER_* documents missing a Source Registry.
- The source-verifier agent re-reads source files independently and checks tokens against the document's registry. It issues a PASS/PARTIAL/FAIL verdict.
- Agent prompts injected by Pattern 2 explicitly require last-line tokens in the verification block.

**Rule formulation (from rh-read-integrity.md):**
```
For any consolidation task, record for every file:
- Literal last line (verbatim) — the verification token
- Total line count of the file
- Which lines were actually read (e.g., "lines 1–200 of 639")

Never label a file as "read," "incorporated," or "subsumed" without this data.
```

---

## 6. The Scribe Pattern

**Trigger:** `/rh-quit` skill (user-invoked)

**Problem:** Useful insights, cleanup items, and learnings surface during a session but are never durably captured. The session ends, the transcript is accessible but unindexed, and the next session starts fresh without the accumulated context.

**Solution:** End-of-session drain that dispatches a single `rh-scribe-multiscope` subagent to extract and file three categories of content from the transcript tail:
- **Recommendations** → `recommendations.md` (future improvements)
- **Cleanup items** → `cleanup.md` (TODOs, leftover artifacts, stale references)
- **Learnings** → `~/.claude/memory-shared/learnings/<topic>.md` (capability deltas, vocabulary, decision rules)

The scribe agent handles deduplication (skips rows already present), categorization (distinguishes a recommendation from a cleanup item), and file writes — all in one LLM pass.

**Key design choices:**
- **One agent, three outputs.** Early versions dispatched three separate scribe agents (one per category). A single multiscope agent cuts the `/rh-quit` wall-clock time from ~286s to ~90s by eliminating the fan-out overhead and the three separate transcript reads.
- **Learnings go to `~/.claude/memory-shared/`, not to the project.** Project files rotate; memory-shared persists across sessions and projects. Learnings are the longest-lived content.
- **The prefilter (Pattern 4, Stage 1) handles inline extraction; the scribe handles quality synthesis.** The prefilter runs on every Stop and captures low-signal markers quickly. The scribe runs once at session end and produces higher-quality, deduplicated, organized output.

**Per-turn staging (opt-in):** Enable `scribeStaging: true` in `~/.claude/oversight.json` to write per-turn JSONL staging files. The scribe then reads the staging file instead of the 10K-char transcript tail — eliminating the truncation risk on long sessions.

---

## 7. The Atomic Writer Pattern

**Used by:** scribe-prefilter, scribe-table-write, generate-state-md, render-md-html, daily-regen

**Problem:** Multiple Claude Code sessions (parallel terminals, background tasks, the daily-regen cron) can race to append to the same file. Naive `fs.appendFileSync` has a TOCTOU window; two appenders can corrupt each other's records.

**Solution:** O_EXCL lockfile with exponential backoff + jitter.

```js
function withLock(lockPath, fn, opts = {}) {
  const { maxRetries = 30, baseMs = 40 } = opts;
  for (let i = 0; i < maxRetries; i++) {
    try {
      // O_EXCL is atomic at the OS level — only one writer wins
      fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      try {
        return fn();          // <-- read + write must BOTH happen inside this block
      } finally {
        fs.unlinkSync(lockPath);
      }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Stale lock recovery: if PID in lockfile is dead, break it
      const age = Date.now() - fs.statSync(lockPath).mtimeMs;
      if (age > 5000) fs.unlinkSync(lockPath);
      // Jitter to avoid thundering herd
      const wait = baseMs * Math.pow(1.5, i) + Math.random() * 20;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
    }
  }
  throw new Error(`withLock: could not acquire ${lockPath} after ${maxRetries} retries`);
}
```

**Key design choices:**
- **The work function must do read + write inside the callback.** The common mistake is to read outside the lock and write inside it — this re-introduces the TOCTOU window. Both operations must be atomic together.
- **5s stale lock recovery.** A crashed writer leaves a lockfile. Without recovery, subsequent writers deadlock. Check PID liveness; if the PID is dead, break the lock.
- **Jitter on every retry.** Without jitter, N writers retrying at the same cadence produce synchronized contention spikes. Random jitter spreads load.
- **JSONL append is the exception.** Single-line JSONL appends are effectively atomic at the OS level (writes < 4KB are atomic on Linux/macOS). Don't wrap JSONL event logs in a lockfile — the overhead isn't worth it.

---

## 8. The Supervisor Preload Pattern

**Hook:** `SessionStart`

**Problem:** Claude's oversight rules are loaded as CLAUDE.md instructions at the start of every session, but the specific self-check that matters *before declaring a turn done* is buried in the rules. By the time Claude finishes a complex task, it may not recall the precise framing.

**Solution:** A `SessionStart` hook injects a condensed, action-triggering version of the 3 most critical rules as `additionalContext` at the very start of the session — before any user message.

```json
{
  "type": "command",
  "command": "node ~/.claude/scripts/rh-supervisor-preload.js"
}
```

The preload script outputs:
```json
{
  "additionalContext": "## Self-check before declaring a turn done (3 rules)\n\n1. VERIFY BEFORE DECLARING DONE...\n2. SUBAGENT CROSS-CHECK...\n3. NO UNVERIFIED EXTRAPOLATION..."
}
```

**Key design choices:**
- **3 rules, not all rules.** The full rule set is already in CLAUDE.md. The preload is a *memory aid* for the most consequential rules — the ones that generate the most Stop-hook rejections. Keeping it to 3 rules ensures it's read and remembered rather than skipped.
- **Framed as a self-check, not a prohibition.** "Before saying done, run this self-check" is more effective than "do not claim completion without verifying." The self-check framing gives Claude a concrete action to take.
- **The preload must be fast (< 100ms).** It fires on every SessionStart. If it does significant I/O, it delays the session. The preload script should be pure stdout and exit.

---

## 9. The Self-Test Pattern

**Trigger:** Daily (via SessionStart trigger + same-day guard) and manual

**Problem:** A hook script that worked yesterday may silently stop working today — due to a Node.js version change, a path rename, a schema change in Claude Code's hook input format, or an edit to the script itself. There's no test-driven feedback loop for hooks. You find out the guard isn't working when a bad output slips through.

**Solution:** A self-test script runs each enforcement hook against a *known-violating fixture* and verifies the expected block/allow/mutate behavior.

```js
// self-test structure
const tests = [
  {
    name: 'consolidation-guard blocks MASTER_ without registry',
    script: 'rh-consolidation-guard.js',
    input: { tool_input: { file_path: 'MASTER_REPORT.md', content: 'no registry here' } },
    expect: result => result.action === 'block'
  },
  {
    name: 'agent-oversight-guard injects block when missing',
    script: 'rh-agent-oversight-guard.js',
    input: { tool_input: { prompt: 'research this topic', description: 'my agent' } },
    expect: result => result.action === 'allow' && result.updatedInput?.prompt?.includes('verification token')
  },
  // ...37 tests total
];
```

**Key design choices:**
- **Hard pass vs soft pass.** Tests that validate enforcement behavior are "hard" — failure means a guard is broken and sessions are unprotected. Tests that validate telemetry, optional features, or UI are "soft" — failure is surfaced but doesn't fail the suite. The 37-test suite has 0 soft failures by design; everything is load-bearing.
- **Run with `OVERSIGHT_SELF_TEST=1`.** Guards that post to telemetry check this env var and skip the HTTP call. Self-tests shouldn't generate telemetry events — it muddies the signal.
- **The same-day guard.** The daily trigger checks a `~/.claude/regen-ran-<date>.flag` sentinel to avoid running the self-test twice in the same day (e.g., if the user opens multiple sessions). If the flag exists, the trigger exits immediately.

---

## 10. The Zero-Hardcoded-Paths Pattern

**Used by:** every script in the framework

**Problem:** Sharing a Claude Code configuration across users is harder than it should be. Scripts that hardcode `~/username/.claude/` or `C:/Users/alice/OneDrive/...` work for one developer and break for everyone else. The same problem applies to sharing within a team or open-sourcing the framework.

**Solution:** All path resolution goes through a single config module. The module resolves paths in priority order: environment variable → `~/.claude/oversight.json` → auto-detect from CWD.

```js
// packages/shared/config.js
function resolveConfig() {
  // 1. Env var override (highest priority, useful in CI and tests)
  if (process.env.RH_WORKSPACE) return buildConfig(process.env.RH_WORKSPACE);

  // 2. ~/.claude/oversight.json (written by `rh-oversight init`)
  const stored = readOversightJson();
  if (stored?.workspace) return buildConfig(stored.workspace, stored);

  // 3. Auto-detect: walk up from CWD looking for .claude/rules/
  const detected = walkUpForDotClaude(process.cwd());
  if (detected) return buildConfig(detected);

  throw new Error('Cannot resolve workspace. Run `rh-oversight init` first.');
}
```

**Verification:** The `npm test` suite includes a grep-based check: `grep -r "rossb|C:/Users/rossb" packages/` must return no matches. This runs as part of the framework's own CI to prevent regression.

**Key design choices:**
- **Environment variable override is essential for tests.** Tests set `HOME=/tmp/test-home` and `RH_WORKSPACE=/tmp/test-ws` to run against disposable directories. Without env var override, tests would modify the developer's real `~/.claude/` directory.
- **Write `~/.claude/oversight.json` at install time, not at runtime.** The config file is written once by `rh-oversight init`. Scripts that run on every hook event read it as a static file — no config mutation at runtime.
- **Path resolution is cached per process.** Hooks fire dozens of times per session. Re-reading the config file on every hook invocation adds measurable latency. Cache the result after the first read.

---

## Pattern Reference

| Pattern | Hook Event | Failure mode it closes | Key technique |
|---|---|---|---|
| Guard | PreToolUse | Output written without required structure | Block + `message` + telemetry emit |
| Auto-Inject | PreToolUse:Agent | Subagents run without oversight requirements | `updatedInput` prompt mutation |
| Audit | PostToolUse | Silent file truncation; subagent failures go unnoticed | Log + non-blocking warn |
| Multi-Stage Stop | Stop (×3) | Session value not captured; rejections not persisted | Ordered hooks: extract → review → capture |
| Verification Token | Rules + agents | "Read" claims can't be externally audited | Last line verbatim as EOF proof |
| Scribe | User skill (/rh-quit) | Session insights lost at close | Single-agent multiscope drain to persistent files |
| Atomic Writer | All output scripts | Concurrent writes corrupt shared files | O_EXCL lockfile + jitter + stale recovery |
| Supervisor Preload | SessionStart | Self-check rules not top-of-mind at turn end | Condensed 3-rule `additionalContext` injection |
| Self-Test | Daily + manual | Hook behavior silently regresses | Known-violating fixtures + hard-pass suite |
| Zero Hardcoded Paths | All scripts | Config breaks when shared across users | env var > oversight.json > auto-detect CWD walk |

---

## Implementation Notes

All patterns above are implemented in [`rh-claude-framework`](https://github.com/toolbeltross/rh-claude-framework). The framework ships them as a single installable package:

```bash
node packages/cli/bin/rh-oversight.js init [--workspace <path>]
```

After install:
- 25 enforcement scripts → `~/.claude/scripts/`
- 19 agent definitions → `~/.claude/agents/`
- 12 workspace rules → `<workspace>/.claude/rules/`
- Hooks wired into `~/.claude/settings.json` (additive merge, preserves your existing entries)

Verify with `rh-oversight self-test` → expect `37/37 hard passed`.

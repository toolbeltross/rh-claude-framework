# Supervisory Agent Prompt

Reference documentation for the Stop-hook supervisory review. The live prompt body is inlined in `scripts/setup-hooks.js` (prompt hooks can't read files at runtime — Claude Code requires the prompt string inline in settings.json).

## Layer 3a — Stop Prompt Hook (ACTIVE, narrow 3-rule variant)

**Hook type:** `prompt` (single-turn LLM evaluation, default model: Haiku)
**Fires on:** every `Stop` event (turn boundary)
**Cost estimate:** roughly 30–40% of the original 5-rule prompt. See `CLAUDE.md` history for the 5-rule variant's $6.30–13.95/session figure.

### Why a narrow 3-rule variant?

The original Layer 3a prompt evaluated 5 rules covering additive-only, no-deviation, correct-tools, no-flip-flop, and priority-order. It was removed 2026-03 for cost reasons, with the rationale that `CLAUDE.md` conventions were adequate.

Re-enabled 2026-04-19 with a narrower 3-rule scope targeting a specific class of failure that leaked through unverified during a domain-review session:

- A subagent reported a numeric attribution as belonging to entity A. Claude passed the attribution to the user without reading the underlying source document. The value was actually attributable to entity B (a different row in a multi-entity table). The pre-existing CLAUDE.md conventions did not catch this because the failure wasn't a rule-of-thumb violation — it was an unverified extrapolation from subagent output.

The 3 rules are designed to intercept that specific class of failure without the cost of evaluating the full 5-rule set on every turn. Specific entity names and dollar amounts from the originating incident are kept private and intentionally not reproduced here.

### The 3 rules

1. **VERIFY BEFORE DECLARING DONE** — Before calling work "done", "tested", "ready", or "complete", did Claude verify through the OUTER SEAM (not just the inner unit)? Source: `.claude/rules/work-verification.md`.

2. **SUBAGENT CROSS-CHECK** — If a subagent returned facts passed to the user, did Claude (a) verify from source when the fact drives a downstream decision, and (b) flag any disagreement between two subagents on the same field? Source: `.claude/rules/subagent-oversight.md`.

3. **NO UNVERIFIED EXTRAPOLATION** — Did Claude present any non-trivial factual claim that did not come from (a) a file read this session, (b) a subagent output with a verification token, or (c) a tool-call result? Source: `.claude/rules/read-integrity.md`.

### Behavior

- `{"ok": true}` — Claude stops normally.
- `{"ok": false, "reason": "[Rule N] — ..."}` — Claude Code surfaces the reason as a system reminder; Claude is prompted to continue and address the violation.
- `{"ok": true, "reason": "loop-break: ..."}` — the LLM self-breaks a rejection loop; see below.

### Loop-break (B1′-opt, LLM-self-interpreted)

The inlined prompt includes a LOOP-BREAK CHECK evaluated before the 3 rules:

- **Max 3 consecutive rejections** — if the transcript shows 3+ consecutive assistant turns with no intervening user message, the reviewing LLM returns `{"ok": true, "reason": "loop-break: 3+ consecutive rejections detected..."}`. That ends the turn cleanly so the user can direct or provide guidance.
- **Same-reason repetition** — if the LLM's prior rejection reason appears nearly identical to a rejection already issued in the immediately preceding consecutive assistant turn (same rule cited, same violation description), it self-breaks with `{"ok": true, "reason": "loop-break: identical rejection reason repeated..."}`.

**Limitation — LLM-interpreted, not deterministic.** The check relies on the supervising LLM correctly counting consecutive turns and comparing reason text. It's directionally reliable on Haiku-class models but could miss edge cases where the transcript is compressed or the boundaries are ambiguous. Telemetry's B1′ forced-continuation detection (`_consecutiveForcedContinuations` on the live session) is the deterministic fallback observability surface — if the LLM misses a loop, the dashboard's red "Possible Stop-hook loop" banner still fires at ≥2 and Ross can interrupt manually.

**Future Option B — fully deterministic wrapper.** Replace the prompt hook with a command hook that invokes the LLM ourselves (via `claude` CLI or the Anthropic SDK), captures the `{ok, reason}` response directly, and maintains `~/.claude/supervisor-state.json` to track consecutive count and last reason across Stop events. That path gives full visibility into reason text and deterministic same-reason matching, but adds an LLM-invocation dependency and ~3–4 hours of work. Parked until the MVP proves insufficient.

### Idempotency marker

The inlined prompt begins with `ADDITIVE ONLY` so that `npm run setup-hooks` can detect our entries during re-runs and avoid stripping foreign prompt hooks. See `filterOurEntries` in `setup-hooks.js`.

## Layer 3b — Stop Agent Hook (SCHEMA SUPPORTED, NOT WIRED)

**Status discovered 2026-04-19:** the Claude Code settings.json validator accepts `type: "agent"` hooks. The schema requires a `prompt` field (not `agent: "name"` as the original plan assumed). Default model is Haiku; override via `model`.

**Why not wired today:** firing both a prompt hook AND an agent hook on every `Stop` roughly doubles the per-turn cost. The narrow-3-rule variant was chosen specifically to reduce cost, so adding a second always-on reviewer defeats that decision.

**When to wire:** if deeper multi-turn review is wanted on specific turn classes (e.g., after large consolidations or subagent dispatches), a gated agent hook with an `if` clause could complement Layer 3a without doubling cost. Leave as a parked decision until concrete need surfaces.

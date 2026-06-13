// rh-supervisor-preload.js
// SessionStart hook (added 2026-05-02, Phase 3 of oversight roadmap).
//
// Emits the supervisor's narrowed 3-rule self-check framing as additionalContext
// at SessionStart. Same rule set the Layer 3a Stop-hook prompt (in settings.json)
// uses for post-hoc rejection — reframed as forward guidance so Claude can
// self-check before declaring a turn done. Goal: prevent rejection round-trips
// for the recurring Rule 1 violation pattern (declaring done without outer-seam
// verification of artifact-state changes).
//
// The 3 underlying rules (rh-work-verification.md, rh-subagent-oversight.md,
// rh-read-integrity.md) are already preloaded via the workspace .claude/rules/
// chain. This hook adds the *narrowed framing* — the sharper restatement the
// post-hoc judge uses — so it's available proactively rather than only on
// rejection.
//
// Decision (recorded in plan): the 4th element about subagent-dispatch-prompt
// content (verificationToken/contextReport/batchOverflow) is NOT included.
// That's a different oversight layer (PreToolUse:Agent guard) which already
// auto-heals; mixing concerns blurs the framing.

const { wrapHook } = require('./lib/hook-timing');

const PRELOAD_TEXT = `## Self-check before declaring a turn done (3 rules)

Before you finish a turn — especially before words like "done", "tested", "ready", "complete", or "verified" — run this self-check. These are the same three rules the Stop-hook supervisor judges against; catching a violation here saves a rejection round-trip.

1. VERIFY BEFORE DECLARING DONE — If the work touches a user-facing surface (command, hook, CLI entry point, build/test pipeline, generated artifact, rendered DOM, deployed config), verify through the OUTER SEAM in this session. Running an inner unit test or reading the source file is not sufficient when the claim is about end-to-end behavior. Artifact-state changes (file moved, config edited, hook wired) require re-verifying the outer seam still works after the change, not just confirming the change landed on disk. Source: .claude/rules/rh-work-verification.md.

2. SUBAGENT CROSS-CHECK — If you are passing subagent-returned facts to the user: (a) verify from the original source when the fact drives a downstream decision, and (b) flag any disagreement between two subagents on the same field and resolve it with a tiebreaker before reporting. Passing subagent output through unverified when stakes are factual attribution is a violation. Source: .claude/rules/rh-subagent-oversight.md.

3. NO UNVERIFIED EXTRAPOLATION — Every non-trivial factual claim in your turn must come from (a) a file you read in this session, (b) a subagent output with a verification token, or (c) a tool-call result. Do not substitute from training knowledge or memory without citation when the user is relying on correctness. Source-adequacy also matters: a claim about rendered or effective state requires a source that observes the effective state — counting CSS declarations does not answer how many distinct font sizes the rendered DOM produces; counting agent files on disk does not answer which agents actually loaded. Source: .claude/rules/rh-read-integrity.md.

If any of the three would fail right now, stop and fix it before declaring the turn done.`;

wrapHook('supervisor-preload', () => {
  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: PRELOAD_TEXT,
    },
  };
}, { hookType: 'SessionStart' });

import { readFile, writeFile, copyFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { homedir, platform } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';

import { repairStatusLine } from './repair-statusline.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const START_BG_SCRIPT = join(PROJECT_ROOT, 'scripts', 'start-bg.js').replace(/\\/g, '/');
const HOOK_FORWARDER = join(PROJECT_ROOT, 'scripts', 'hook-forwarder.js').replace(/\\/g, '/');
const TOOL_VALIDATOR_V2 = join(PROJECT_ROOT, 'scripts', 'tool-validator-v2.js').replace(/\\/g, '/');

// Detect WSL: Node on WSL reports platform 'linux' but the filesystem may be mounted via /mnt/
const IS_WSL = platform() === 'linux' && !!process.env.WSL_DISTRO_NAME;

import { PORT, BASE_URL } from '../server/config.js';

const HOOK_URL = `${BASE_URL}/api/hooks`;
const STATUS_URL = `${BASE_URL}/api/status`;

// --- CLI flags ---
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FORCE_STATUSLINE = args.includes('--statusline') || args.includes('--force-statusline');

/** Get the settings.json path for the current user */
function getSettingsPath() {
  return join(homedir(), '.claude', 'settings.json');
}

/**
 * Build the canonical hook configuration.
 *
 * Note: this function no longer touches settings.statusLine — that's handled
 * separately by a call to repairStatusLine() from main() so the classifier-driven
 * interactive prompt can run at the right point in the setup flow.
 */
export function buildHookConfig(existingSettings) {
  const settings = { ...existingSettings };
  if (!settings.hooks) settings.hooks = {};

  // Helper: filter out our telemetry entries from an existing hook array.
  // Filters PER-HOOK inside each entry's inner array, not per-entry, so foreign
  // hooks sharing an entry with ours (e.g., daily-regen-trigger.js alongside
  // start-bg.js under SessionStart) survive.
  function filterOurEntries(arr, marker) {
    if (!Array.isArray(arr)) return [];
    const matchesOurHook = (h) =>
      h.command?.includes(marker) || h.command?.includes(HOOK_URL) || h.command?.includes(STATUS_URL) ||
      h.command?.includes('progress-tracker') || h.command?.includes('statusline.js') ||
      ((h.type === 'prompt' || h.type === 'agent') && h.prompt?.includes('ADDITIVE ONLY'));
    const out = [];
    for (const entry of arr) {
      if (entry.hooks) {
        const remaining = entry.hooks.filter((h) => !matchesOurHook(h));
        if (remaining.length > 0) {
          out.push({ ...entry, hooks: remaining });
        }
        // If remaining.length === 0, the entire entry was ours; drop it.
        continue;
      }
      // Entry-level hook without an inner hooks array
      if (entry.command?.includes(marker) || entry.command?.includes(HOOK_URL)) continue;
      out.push(entry);
    }
    return out;
  }

  // --- SessionStart: auto-start telemetry server ---
  settings.hooks.SessionStart = [
    ...filterOurEntries(settings.hooks.SessionStart, 'start-bg.js'),
    { hooks: [{ type: 'command', command: `node "${START_BG_SCRIPT}" > /dev/null 2>&1 || true` }] },
  ];

  // --- PostToolUse: forward tool events ---
  settings.hooks.PostToolUse = [
    ...filterOurEntries(settings.hooks.PostToolUse, 'hook-forwarder'),
    { hooks: [{ type: 'command', command: `node "${HOOK_FORWARDER}" tool "$CLAUDE_TOOL_NAME" "$CLAUDE_SESSION_ID" post_tool_use` }] },
  ];

  // --- PostToolUseFailure: forward tool failures ---
  settings.hooks.PostToolUseFailure = [
    ...filterOurEntries(settings.hooks.PostToolUseFailure, 'hook-forwarder'),
    { hooks: [{ type: 'command', command: `node "${HOOK_FORWARDER}" tool-failure "$CLAUDE_TOOL_NAME" "$CLAUDE_SESSION_ID"` }] },
  ];

  // --- PreToolUse:Bash — Layer 1 environment-aware validation (v2) ---
  // Uses contextAddition (SUGGEST) instead of exit 2 (BLOCK) for wrong-tool patterns.
  // Prevents cascade cancellation of parallel tool calls.
  settings.hooks.PreToolUse = [
    ...filterOurEntries(settings.hooks.PreToolUse, 'tool-validator'),
    {
      matcher: 'Bash',
      hooks: [{ type: 'command', command: `node "${TOOL_VALIDATOR_V2}"`, timeout: 5 }],
    },
  ];

  // --- Stop: turn boundary telemetry + Layer 3 supervisory review ---
  // Layer 3a (prompt) — ACTIVE: narrow 3-rule review targeting subagent-attribution failure modes (one specific incident motivated re-enabling, kept private).
  // Layer 3b (agent)  — Schema now supported by Claude Code per settings.json validator (2026-04-19).
  //                    NOT wired: firing both prompt+agent on every Stop would double the cost.
  //                    To add: insert a third { type: 'agent', prompt: '...verify instructions...' }
  //                    entry below. The agent hook requires a `prompt` field (not `agent`). Default
  //                    model is Haiku; override via `model: 'claude-sonnet-4-6'` if deeper review wanted.
  settings.hooks.Stop = [
    ...filterOurEntries(settings.hooks.Stop, 'hook-forwarder'),
    {
      hooks: [
        { type: 'command', command: `node "${HOOK_FORWARDER}" stop "$CLAUDE_SESSION_ID"` },
        {
          type: 'prompt',
          prompt: `ADDITIVE ONLY — Layer 3a narrow supervisory review. Claude just finished its most recent assistant turn. Review ONLY that most recent turn against exactly 3 rules and return JSON. Historical claims from earlier in the conversation are OUT OF SCOPE — do not re-flag violations from prior turns; assume any past issues have been acknowledged and addressed.

LOOP-BREAK CHECK (evaluate FIRST, before the 3 rules):
Inspect the recent conversation history. If you see 3 or more consecutive assistant turns with no intervening user message between them — meaning a Stop hook has already rejected this turn 3+ times in a row and forced Claude to continue without the user ever weighing in — respond IMMEDIATELY with {"ok": true, "reason": "loop-break: 3+ consecutive rejections detected without user intervention — deferring to user. Original concerns may still apply; user should review."} and STOP. Do NOT evaluate the 3 rules in that case.

Also loop-break if your previous rejection reason appears nearly identical to a rejection you (or a prior supervisor turn) already issued in the immediately preceding consecutive assistant turn — same rule cited and substantively the same violation description. Same-reason repetition means the rejection did not produce a correction; continuing to reject wastes cost and user time. Respond {"ok": true, "reason": "loop-break: identical rejection reason repeated — deferring to user for review."} and STOP.

Otherwise, proceed with the 3 rules below:

1. VERIFY BEFORE DECLARING DONE — In the most recent turn, before calling work "done", "tested", "ready", or "complete", did Claude verify through the OUTER SEAM (not just the inner unit)? If Claude declared completion of a task that touches a user-facing command, hook, CLI entry point, or build/test pipeline without actually running that entry point in this session, that is a violation. Source: .claude/rules/work-verification.md.

2. SUBAGENT CROSS-CHECK — In the most recent turn, if Claude passed subagent-returned facts to the user, did Claude (a) verify from source when the fact drives a downstream decision, and (b) flag any disagreement between two subagents on the same field? Passing subagent output through without verification when the stakes are factual attribution = violation. Two subagents disagreeing without a tiebreaker = violation. Source: .claude/rules/subagent-oversight.md.

3. NO UNVERIFIED EXTRAPOLATION — In the most recent turn, did Claude present any non-trivial factual claim that did not come from (a) a file Claude read in this session, (b) a subagent output with a verification token, or (c) a tool-call result? Substituting from training knowledge or memory without citation when the user is relying on correctness = violation. Source: .claude/rules/read-integrity.md.

Evaluate the MOST RECENT TURN only. If all 3 rules pass for that turn, respond: {"ok": true}
If any rule is violated IN THE MOST RECENT TURN, respond: {"ok": false, "reason": "[Rule N] — [specific description of what went wrong in the most recent turn]"}
Do NOT flag violations from prior turns — acknowledging a past violation in the current turn is sufficient to close it. Be strict on rule 2 — a prior incident where a specific dollar-amount subagent attribution reached the user unverified was exactly this failure.`,
        },
      ],
    },
  ];

  // --- PreCompact: detect context compaction ---
  settings.hooks.PreCompact = [
    ...filterOurEntries(settings.hooks.PreCompact, 'hook-forwarder'),
    { hooks: [{ type: 'command', command: `node "${HOOK_FORWARDER}" compact "$CLAUDE_SESSION_ID"` }] },
  ];

  // --- SessionEnd: mark session ended on the dashboard (kept until stale prune) ---
  settings.hooks.SessionEnd = [
    ...filterOurEntries(settings.hooks.SessionEnd || [], 'hook-forwarder'),
    { hooks: [{ type: 'command', command: `node "${HOOK_FORWARDER}" session-end "$CLAUDE_SESSION_ID"` }] },
  ];

  // --- PermissionRequest: surface "waiting on permission" state ---
  settings.hooks.PermissionRequest = [
    ...filterOurEntries(settings.hooks.PermissionRequest || [], 'hook-forwarder'),
    { hooks: [{ type: 'command', command: `node "${HOOK_FORWARDER}" permission-request "$CLAUDE_SESSION_ID"` }] },
  ];

  // --- SubagentStart: track spawned subagents ---
  settings.hooks.SubagentStart = [
    ...filterOurEntries(settings.hooks.SubagentStart, 'hook-forwarder'),
    { hooks: [{ type: 'command', command: `node "${HOOK_FORWARDER}" subagent-start "$CLAUDE_SESSION_ID"` }] },
  ];

  // --- SubagentStop: telemetry ---
  settings.hooks.SubagentStop = [
    ...filterOurEntries(settings.hooks.SubagentStop, 'hook-forwarder'),
    {
      hooks: [
        { type: 'command', command: `node "${HOOK_FORWARDER}" subagent-stop "$CLAUDE_SESSION_ID"` },
      ],
    },
  ];

  // --- UserPromptSubmit: capture current prompt ---
  settings.hooks.UserPromptSubmit = [
    ...filterOurEntries(settings.hooks.UserPromptSubmit, 'hook-forwarder'),
    { hooks: [{ type: 'command', command: `node "${HOOK_FORWARDER}" user-prompt "$CLAUDE_SESSION_ID"` }] },
  ];

  // --- ConfigChange: log settings modifications ---
  settings.hooks.ConfigChange = [
    ...filterOurEntries(settings.hooks.ConfigChange || [], 'hook-forwarder'),
    { hooks: [{ type: 'command', command: `node "${HOOK_FORWARDER}" config-change "$CLAUDE_SESSION_ID"` }] },
  ];

  // --- TaskCompleted: log task completions ---
  settings.hooks.TaskCompleted = [
    ...filterOurEntries(settings.hooks.TaskCompleted || [], 'hook-forwarder'),
    { hooks: [{ type: 'command', command: `node "${HOOK_FORWARDER}" task-completed "$CLAUDE_SESSION_ID"` }] },
  ];

  // --- InstructionsLoaded: Anthropic-recommended audit/compliance hook ---
  // Fires when CLAUDE.md or workspace rules are loaded. Persisted to
  // oversight-events.jsonl so the supervisor sweep can detect cross-session
  // CLAUDE.md drift. Added 2026-05-08 (P2-3).
  settings.hooks.InstructionsLoaded = [
    ...filterOurEntries(settings.hooks.InstructionsLoaded || [], 'hook-forwarder'),
    { hooks: [{ type: 'command', command: `node "${HOOK_FORWARDER}" instructions-loaded "$CLAUDE_SESSION_ID"` }] },
  ];

  // StatusLine is handled separately via repairStatusLine() in main() — do NOT
  // touch settings.statusLine here. Preserving whatever the existing settings
  // have is correct; repairStatusLine runs after the hooks write and will
  // classify + prompt + rewrite as needed.
  if (existingSettings?.statusLine) {
    settings.statusLine = existingSettings.statusLine;
  }

  return settings;
}

async function deployToPath(settingsPath) {
  let settings = {};
  try {
    const raw = await readFile(settingsPath, 'utf-8');
    settings = JSON.parse(raw);
  } catch {
    console.log(`  No existing ${settingsPath}, creating new.`);
  }

  const updated = buildHookConfig(settings);

  if (DRY_RUN) {
    console.log(`\n  [DRY RUN] Would write to: ${settingsPath}`);
    console.log(`  Hook events: ${Object.keys(updated.hooks).join(', ')}`);
    console.log(`  StatusLine: would run classifier + interactive repair`);
    return;
  }

  // Backup before writing
  if (existsSync(settingsPath)) {
    const backupPath = settingsPath + '.bak';
    await copyFile(settingsPath, backupPath);
    console.log(`  Backup: ${backupPath}`);
  }

  await writeFile(settingsPath, JSON.stringify(updated, null, 2));
  console.log(`  Hooks written: ${settingsPath}`);

  // Now run the classifier-driven statusLine repair. This is a separate step
  // because unknown-custom triggers an interactive prompt, and we want that to
  // run AFTER the hooks are in place so the user isn't confused about the state.
  console.log('');
  console.log('  StatusLine repair:');
  await repairStatusLine({ force: FORCE_STATUSLINE, quiet: false });
}

async function main() {
  const settingsPath = getSettingsPath();
  console.log(`\nSetup hooks v2 — ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log('');

  console.log(`Profile: ${settingsPath}`);
  await deployToPath(settingsPath);
  console.log('');

  console.log('  Endpoints:');
  console.log('    Tool events:     ' + HOOK_URL);
  console.log('    Status line:     ' + STATUS_URL);
  console.log(`    Turn-end:        ${BASE_URL}/api/turn-end`);
  console.log(`    Compact:         ${BASE_URL}/api/compact`);
  console.log(`    Subagent:        ${BASE_URL}/api/subagent`);
  console.log(`    Prompt:          ${BASE_URL}/api/prompt`);
  console.log(`    Config change:   ${BASE_URL}/api/config-change`);
  console.log(`    Task completed:  ${BASE_URL}/api/task-completed`);
  console.log('');
  console.log('  Hooks registered:');
  console.log('    SessionStart         — auto-start telemetry server');
  console.log('    PreToolUse:Bash      — environment-aware validation v2 (suggest via contextAddition)');
  console.log('    PostToolUse          — forward tool events');
  console.log('    PostToolUseFailure   — forward tool failures');
  console.log('    Stop                 — turn boundary telemetry + Layer 3a supervisory prompt (active)');
  console.log('    PreCompact           — detect context compaction');
  console.log('    SubagentStart        — track subagent spawns');
  console.log('    SubagentStop         — telemetry');
  console.log('    UserPromptSubmit     — capture current prompt');
  console.log('    ConfigChange         — log settings modifications');
  console.log('    TaskCompleted        — log task completions');
  console.log('    InstructionsLoaded   — audit log when CLAUDE.md / rules load');
  console.log('    statusLine           — live session data (cost, context, model)');
  console.log('');

  if (IS_WSL) {
    console.log('  [WSL] Detected WSL environment. Paths use WSL filesystem.');
    console.log('  [WSL] To also cover Windows-native, run setup from a Windows terminal too.');
    console.log('');
  }

  console.log('  If the telemetry server is not running, all POSTs silently fail.');
  if (DRY_RUN) console.log('\n  Re-run without --dry-run to apply changes.');
}

// Guard: only run main() when invoked as a CLI, not on import (tests import
// buildHookConfig directly and must not trigger settings.json writes).
// pathToFileURL matches import.meta.url's percent-encoding (e.g. spaces → %20);
// a hand-built `file://` string breaks on paths like C:\Users\First Last.
const argv1 = process.argv[1] || '';
const isCliEntry = argv1.length > 0 && import.meta.url === pathToFileURL(argv1).href;
if (isCliEntry) {
  main().catch(console.error);
}
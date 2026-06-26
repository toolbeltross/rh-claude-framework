// lib/settings-validator.js
//
// Pure schema validator for Claude Code settings.json. Used by:
//   - lib/init.js — pre-write gate during `rh-oversight init` / `reset`
//   - bin/rh-oversight.js `settings validate` / `settings merge`
//   - tests/test-settings-validator.js
//
// Origin: 2026-05-10 plan P2-4. The F-10 incident (telemetry hook silently
// dropped after `rh-oversight init` clobbered the Stop chain) revealed that
// no layer existed to catch shape-broken settings.json before write — once
// a bad merge landed, the supervisory log went dark for 3 days. This
// validator is the "schema-validation pre-write minimum" the plan calls for.
//
// Design tenets:
//   - PURE FUNCTION. No I/O. Caller reads the file, passes the parsed object.
//   - Distinguishes ERRORS (block the write) from WARNINGS (allow but flag).
//   - Returns structured codes (string IDs like "hooks.entry.missing-hooks")
//     so callers can present targeted help, not just blob messages.
//   - Schema is intentionally loose where Claude Code is loose — we don't
//     reject keys we don't recognize. Future-additive Claude Code schema
//     changes should not require validator updates to keep init working.

// Top-level fields we recognize (others are passed through as warnings only
// if they look suspicious — by default we leave them alone).
const KNOWN_TOP_LEVEL = new Set([
  'model', 'env', 'hooks', 'permissions', 'apiKeyHelper',
  'theme', 'feedbackSurveyState', 'forceLoginMethod', 'autoUpdates',
  'enableAllProjectMcpServers', 'enabledMcpjsonServers', 'disabledMcpjsonServers',
  'cleanupPeriodDays', 'includeCoAuthoredBy', 'statusLine',
]);

// Phases we actively validate. Unknown phase names produce a warning, not
// an error — Claude Code may add new hook types and the framework should
// keep installing without a code change in lock-step.
const KNOWN_PHASES = new Set([
  'SessionStart', 'SessionEnd', 'UserPromptSubmit',
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PreCompact',
  'Stop', 'SubagentStart', 'SubagentStop', 'Notification',
  'ConfigChange', 'TaskCompleted', 'InstructionsLoaded', 'PermissionRequest',
]);

const VALID_HOOK_TYPES = new Set(['command', 'prompt']);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Main entry point. Returns { ok: boolean, errors: [...], warnings: [...] }.
// Each issue has { code, path, message }.
function validateSettings(obj) {
  const errors = [];
  const warnings = [];

  if (!isPlainObject(obj)) {
    errors.push({
      code: 'root.not-object',
      path: '$',
      message: 'settings.json root must be a JSON object',
    });
    return { ok: false, errors, warnings };
  }

  // env — must be a string-to-string map if present
  if ('env' in obj) {
    if (!isPlainObject(obj.env)) {
      errors.push({
        code: 'env.not-object',
        path: '$.env',
        message: `env must be an object, got ${Array.isArray(obj.env) ? 'array' : typeof obj.env}`,
      });
    } else {
      for (const [k, v] of Object.entries(obj.env)) {
        if (typeof v !== 'string') {
          errors.push({
            code: 'env.value.not-string',
            path: `$.env.${k}`,
            message: `env values must be strings, got ${typeof v} for ${k}`,
          });
        }
      }
    }
  }

  // model — must be a string if present
  if ('model' in obj && typeof obj.model !== 'string') {
    errors.push({
      code: 'model.not-string',
      path: '$.model',
      message: `model must be a string, got ${typeof obj.model}`,
    });
  }

  // permissions — must be an object if present, with optional allow/deny arrays
  if ('permissions' in obj && obj.permissions != null) {
    if (!isPlainObject(obj.permissions)) {
      errors.push({
        code: 'permissions.not-object',
        path: '$.permissions',
        message: 'permissions must be an object',
      });
    } else {
      for (const k of ['allow', 'deny', 'additionalDirectories']) {
        if (k in obj.permissions && !Array.isArray(obj.permissions[k])) {
          errors.push({
            code: `permissions.${k}.not-array`,
            path: `$.permissions.${k}`,
            message: `permissions.${k} must be an array`,
          });
        }
      }
    }
  }

  // hooks — the main reason this validator exists
  if ('hooks' in obj && obj.hooks != null) {
    validateHooks(obj.hooks, errors, warnings);
  }

  // Unknown top-level keys → soft warning. We don't reject; Claude Code may
  // add new top-level keys.
  for (const k of Object.keys(obj)) {
    if (!KNOWN_TOP_LEVEL.has(k)) {
      warnings.push({
        code: 'root.unknown-key',
        path: `$.${k}`,
        message: `unknown top-level key "${k}" — preserved as-is but not validated`,
      });
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

function validateHooks(hooks, errors, warnings) {
  if (!isPlainObject(hooks)) {
    errors.push({
      code: 'hooks.not-object',
      path: '$.hooks',
      message: `hooks must be an object keyed by phase name, got ${Array.isArray(hooks) ? 'array' : typeof hooks}`,
    });
    return;
  }

  for (const [phase, entries] of Object.entries(hooks)) {
    const phasePath = `$.hooks.${phase}`;

    if (!KNOWN_PHASES.has(phase)) {
      warnings.push({
        code: 'hooks.phase.unknown',
        path: phasePath,
        message: `unknown hook phase "${phase}" — preserved but not validated against known schema`,
      });
      continue;
    }

    if (!Array.isArray(entries)) {
      errors.push({
        code: 'hooks.phase.not-array',
        path: phasePath,
        message: `hooks.${phase} must be an array`,
      });
      continue;
    }

    if (entries.length === 0) {
      warnings.push({
        code: 'hooks.phase.empty',
        path: phasePath,
        message: `hooks.${phase} is an empty array — entry will have no effect`,
      });
      continue;
    }

    // Validate each entry + collect signatures for duplicate detection
    const sigCounts = new Map();
    entries.forEach((entry, i) => {
      const entryPath = `${phasePath}[${i}]`;
      const sig = validateHookEntry(entry, entryPath, phase, errors, warnings);
      if (sig) sigCounts.set(sig, (sigCounts.get(sig) || 0) + 1);
    });

    // Duplicate-signature warning. Exact same matcher + exact same command/prompt
    // sequence appearing twice is almost always a bad merge (the F-10 failure
    // mode in reverse — the entry was preserved but doubled).
    for (const [sig, count] of sigCounts) {
      if (count > 1) {
        warnings.push({
          code: 'hooks.entry.duplicate',
          path: phasePath,
          message: `${phase} has ${count} entries with identical matcher+commands signature (likely bad merge)`,
        });
      }
    }
  }
}

function validateHookEntry(entry, entryPath, phase, errors, warnings) {
  if (!isPlainObject(entry)) {
    errors.push({
      code: 'hooks.entry.not-object',
      path: entryPath,
      message: `entry must be an object`,
    });
    return null;
  }

  // matcher: optional for matcherless phases (Stop, SessionStart, etc.),
  // string for phases that take one (PreToolUse, PostToolUse). We allow it
  // either way and warn instead of erroring if the convention doesn't match —
  // Claude Code's parser is more permissive than the docs suggest.
  if ('matcher' in entry && entry.matcher !== null && typeof entry.matcher !== 'string') {
    errors.push({
      code: 'hooks.entry.matcher.not-string',
      path: `${entryPath}.matcher`,
      message: 'matcher must be a string when present',
    });
  }

  if (!('hooks' in entry) || !Array.isArray(entry.hooks)) {
    errors.push({
      code: 'hooks.entry.missing-hooks',
      path: `${entryPath}.hooks`,
      message: 'entry must have a "hooks" array',
    });
    return null;
  }

  if (entry.hooks.length === 0) {
    warnings.push({
      code: 'hooks.entry.empty-hooks',
      path: `${entryPath}.hooks`,
      message: 'entry has empty hooks array — entry will have no effect',
    });
  }

  // Per-hook-item validation + signature collection
  const itemSigs = [];
  entry.hooks.forEach((h, j) => {
    const hookPath = `${entryPath}.hooks[${j}]`;
    if (!isPlainObject(h)) {
      errors.push({
        code: 'hooks.item.not-object',
        path: hookPath,
        message: 'hook item must be an object',
      });
      return;
    }
    if (!h.type || !VALID_HOOK_TYPES.has(h.type)) {
      errors.push({
        code: 'hooks.item.bad-type',
        path: `${hookPath}.type`,
        message: `type must be one of ${[...VALID_HOOK_TYPES].join(', ')}, got ${JSON.stringify(h.type)}`,
      });
      return;
    }
    if (h.type === 'command') {
      if (typeof h.command !== 'string' || h.command.trim() === '') {
        errors.push({
          code: 'hooks.item.command.missing',
          path: `${hookPath}.command`,
          message: 'command-type hook requires non-empty "command" string',
        });
        return;
      }
      itemSigs.push(`cmd:${h.command}`);
    } else if (h.type === 'prompt') {
      if (typeof h.prompt !== 'string' || h.prompt.trim() === '') {
        errors.push({
          code: 'hooks.item.prompt.missing',
          path: `${hookPath}.prompt`,
          message: 'prompt-type hook requires non-empty "prompt" string',
        });
        return;
      }
      itemSigs.push(`prompt:${h.prompt.slice(0, 80)}`);
    }
  });

  // Per-entry signature for duplicate detection (uses matcher + ordered item sigs).
  return JSON.stringify({ m: entry.matcher ?? null, hs: itemSigs });
}

// Convenience: validate a file on disk. Returns { ok, errors, warnings, parseError }.
// Caller still does I/O; this only handles the JSON.parse step uniformly.
function validateFile(fs, filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); }
  catch (e) {
    return {
      ok: false,
      errors: [{ code: 'file.read-error', path: filePath, message: e.message }],
      warnings: [],
      parseError: null,
    };
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) {
    return {
      ok: false,
      errors: [{ code: 'file.parse-error', path: filePath, message: `JSON parse failed: ${e.message}` }],
      warnings: [],
      parseError: e,
    };
  }
  const r = validateSettings(parsed);
  return { ...r, parseError: null };
}

// Render issues as a human-readable string. Used by CLI + init error reporting.
function formatIssues({ errors = [], warnings = [] } = {}) {
  const lines = [];
  if (errors.length) {
    lines.push(`ERRORS (${errors.length}):`);
    for (const e of errors) lines.push(`  ✗ [${e.code}] ${e.path}: ${e.message}`);
  }
  if (warnings.length) {
    lines.push(`WARNINGS (${warnings.length}):`);
    for (const w of warnings) lines.push(`  ⚠ [${w.code}] ${w.path}: ${w.message}`);
  }
  if (!lines.length) lines.push('OK — no issues');
  return lines.join('\n');
}

module.exports = {
  validateSettings,
  validateFile,
  formatIssues,
  KNOWN_PHASES,
  KNOWN_TOP_LEVEL,
};

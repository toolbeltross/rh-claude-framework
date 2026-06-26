/**
 * StatusLine classifier — inspects settings.json statusLine.command and returns
 * a structured classification used by setup-hooks, repair CLI, server boot, and
 * the runtime file watcher.
 *
 * Classes:
 *   - telemetry          — command invokes hook-forwarder.js status
 *   - telemetry-wrapper  — command invokes a script marked with // rh-telemetry:wrapped
 *   - placeholder        — command invokes the legacy fallback script (auto-upgrade target)
 *   - unknown-custom     — anything else (interactive prompt target)
 *   - missing            — no statusLine command at all
 */
import { readFileSync, existsSync } from 'fs';

const PLACEHOLDER_MARKER = 'Temporary until rh-telemetry is installed';
const WRAPPER_MARKER = '// rh-telemetry:wrapped';

/**
 * Extract the script path from a statusLine command string.
 * Handles: "node path", "node \"path\"", "node 'path'", "path" (direct), with
 * or without absolute paths, on Windows (forward or back slashes).
 * Returns null if no script path can be extracted.
 */
export function extractScriptPath(cmd) {
  if (!cmd || typeof cmd !== 'string') return null;
  // Match the last .js/.mjs/.cjs token in the command, optionally quoted
  const re = /["']?([^"'\s]+?\.(?:m?js|cjs))["']?/g;
  let match;
  let last = null;
  while ((match = re.exec(cmd)) !== null) {
    last = match[1];
  }
  return last;
}

/**
 * Check if the command looks like a telemetry forwarder invocation.
 * Must contain hook-forwarder (with or without .js) AND the literal 'status' arg.
 */
function isTelemetryCommand(cmd) {
  if (!cmd) return false;
  // Require hook-forwarder in the path and 'status' as a standalone argument
  if (!/hook-forwarder(?:\.js)?/i.test(cmd)) return false;
  // 'status' must appear as an argument, not inside the path (use word boundary + non-path context)
  const argsPart = cmd.replace(/hook-forwarder(?:\.js)?["']?/i, '');
  return /\bstatus\b/.test(argsPart);
}

/**
 * Safely read the first N lines of a script file.
 * Returns empty string on any error (missing, binary, permission denied).
 */
function readHead(path, maxBytes = 8192) {
  try {
    if (!existsSync(path)) return null;
    const content = readFileSync(path, 'utf-8');
    return content.slice(0, maxBytes);
  } catch {
    return null;
  }
}

/**
 * Classify a settings object's statusLine configuration.
 * Does not mutate anything. Safe to call repeatedly.
 *
 * @param {object} settings - Parsed ~/.claude/settings.json
 * @returns {{class: string, command: string, scriptPath: string|null, reason: string|null}}
 */
export function classifyStatusLine(settings) {
  const command = settings?.statusLine?.command || '';

  if (!command) {
    return {
      class: 'missing',
      command: '',
      scriptPath: null,
      reason: 'no statusLine configured',
    };
  }

  if (isTelemetryCommand(command)) {
    return {
      class: 'telemetry',
      command,
      scriptPath: extractScriptPath(command),
      reason: null,
    };
  }

  const scriptPath = extractScriptPath(command);

  if (!scriptPath) {
    return {
      class: 'unknown-custom',
      command,
      scriptPath: null,
      reason: 'command does not reference a .js script',
    };
  }

  // Detect our own CLI-only statusline by filename before reading content.
  // Matches both current name and legacy name. Auto-upgrade target when
  // telemetry is installed — safe because it's our own script.
  if (/statusline-CLI-only\.js|statusline-standalone\.js/.test(scriptPath)) {
    return {
      class: 'cli-only',
      command,
      scriptPath,
      reason: 'CLI-only statusline (not forwarding to telemetry)',
    };
  }

  const head = readHead(scriptPath);

  if (head === null) {
    return {
      class: 'unknown-custom',
      command,
      scriptPath,
      reason: 'script file not readable',
    };
  }

  // Check first two lines for wrapper marker
  const firstTwoLines = head.split('\n').slice(0, 2).join('\n');
  if (firstTwoLines.includes(WRAPPER_MARKER)) {
    return {
      class: 'telemetry-wrapper',
      command,
      scriptPath,
      reason: null,
    };
  }

  if (head.includes(PLACEHOLDER_MARKER)) {
    return {
      class: 'placeholder',
      command,
      scriptPath,
      reason: 'legacy fallback script detected',
    };
  }

  return {
    class: 'unknown-custom',
    command,
    scriptPath,
    reason: 'custom statusLine script (not forwarding to telemetry)',
  };
}

/**
 * Convenience: classify by reading settings.json from the given path.
 */
export function classifyStatusLineFromFile(settingsPath) {
  try {
    const raw = readFileSync(settingsPath, 'utf-8');
    const settings = JSON.parse(raw);
    return classifyStatusLine(settings);
  } catch (err) {
    return {
      class: 'missing',
      command: '',
      scriptPath: null,
      reason: `settings.json unreadable: ${err.message}`,
    };
  }
}

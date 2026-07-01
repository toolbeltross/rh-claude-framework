#!/usr/bin/env node
/**
 * Repair / install / upgrade the Claude Code statusLine to forward data to
 * the telemetry server.
 *
 * Called by:
 *   - scripts/setup-hooks.js — as part of initial setup
 *   - bin/rh-telemetry.js repair-statusline — standalone CLI
 *   - server/statusline-watcher.js — reacts to classification degradation (read-only there, this module writes)
 *
 * Behavior by class:
 *   telemetry / telemetry-wrapper → print "healthy", exit 0, no changes
 *   missing                        → install telemetry forwarder, record history
 *   placeholder                    → auto-upgrade (no prompt), record history
 *   unknown-custom                 → interactive 4-option prompt (replace / wrap / skip / show)
 *
 * Non-TTY + no --force-statusline = no changes made on unknown-custom (safe default).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { createInterface } from 'readline/promises';
import { stdin, stdout } from 'process';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { homedir } from 'os';

import { classifyStatusLineFromFile } from './statusline-classifier.js';
import { appendHistoryEntry } from './statusline-history.js';
import { generateWrapper } from './generate-statusline-wrapper.js';
import { CLAUDE_SETTINGS_PATH } from '../server/config.js';
import { writeFileAtomic } from './fs-atomic.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const HOOK_FORWARDER = join(PROJECT_ROOT, 'scripts', 'hook-forwarder.js').replace(/\\/g, '/');
const WRAPPER_OUTPUT_PATH = join(homedir(), '.claude', 'scripts', 'statusline-wrapped.js');

const TELEMETRY_COMMAND = `node "${HOOK_FORWARDER}" status`;

/**
 * Read and parse settings.json, creating the file if missing.
 * Returns { settings, raw } where settings is the parsed object.
 */
function readSettings(settingsPath = CLAUDE_SETTINGS_PATH) {
  if (!existsSync(settingsPath)) {
    mkdirSync(dirname(settingsPath), { recursive: true });
    return { settings: {}, raw: null };
  }
  try {
    const raw = readFileSync(settingsPath, 'utf-8');
    return { settings: JSON.parse(raw), raw };
  } catch (err) {
    throw new Error(`Failed to read ${settingsPath}: ${err.message}`);
  }
}

/**
 * Write settings.json atomically (temp file + rename). Protects the user's
 * shared settings.json from truncation if the write is interrupted.
 */
function writeSettings(settings, settingsPath = CLAUDE_SETTINGS_PATH) {
  writeFileAtomic(settingsPath, JSON.stringify(settings, null, 2), { encoding: 'utf-8' });
}

/** Rewrite settings.statusLine.command to the telemetry forwarder, preserving other keys. */
export function rewriteToTelemetry(settingsPath = CLAUDE_SETTINGS_PATH) {
  const { settings } = readSettings(settingsPath);
  const prev = settings?.statusLine?.command || '';
  settings.statusLine = { type: 'command', command: TELEMETRY_COMMAND };
  writeSettings(settings, settingsPath);
  return { previousCommand: prev, newCommand: TELEMETRY_COMMAND };
}

/** Rewrite settings.statusLine.command to the wrapper script, preserving other keys. */
export function rewriteToWrapper(wrapperPath, settingsPath = CLAUDE_SETTINGS_PATH) {
  const { settings } = readSettings(settingsPath);
  const prev = settings?.statusLine?.command || '';
  const newCommand = `node "${wrapperPath.replace(/\\/g, '/')}"`;
  settings.statusLine = { type: 'command', command: newCommand };
  writeSettings(settings, settingsPath);
  return { previousCommand: prev, newCommand };
}

export { TELEMETRY_COMMAND };

/**
 * Interactive prompt for the unknown-custom case.
 * Returns the chosen action: 'replace' | 'wrap' | 'skip'.
 */
async function promptUnknownCustom(classification) {
  console.log('');
  console.log('  Your current statusLine is not forwarding data to rh-telemetry.');
  console.log('');
  console.log(`    command: ${classification.command}`);
  if (classification.scriptPath) {
    console.log(`    script:  ${classification.scriptPath}`);
  }
  console.log('');
  console.log('  Without forwarding, the dashboard context window only refreshes');
  console.log('  every ~5-30s (tool-event cadence) instead of sub-second (statusLine cadence).');
  console.log('');
  console.log('  Options:');
  console.log('    [1] Replace with telemetry\'s built-in statusLine (loses your customizations)');
  console.log('    [2] Wrap: keep your statusLine, add telemetry forwarding (recommended)');
  console.log('    [3] Skip: leave unchanged (dashboard shows degraded-mode banner)');
  console.log('    [4] Show me my current script first');
  console.log('');

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    while (true) {
      const answer = (await rl.question('  Choice [1-4]: ')).trim();
      if (answer === '1') return 'replace';
      if (answer === '2') return 'wrap';
      if (answer === '3') return 'skip';
      if (answer === '4') {
        if (!classification.scriptPath || !existsSync(classification.scriptPath)) {
          console.log('  (script path is empty or does not exist — cannot show)');
          continue;
        }
        const content = readFileSync(classification.scriptPath, 'utf-8');
        const lines = content.split('\n');
        const shown = lines.slice(0, 200);
        console.log('');
        console.log(`  --- ${classification.scriptPath} (${lines.length} lines, showing first ${shown.length}) ---`);
        console.log(shown.join('\n'));
        console.log('  --- end ---');
        console.log('');
        continue;
      }
      console.log('  Invalid choice, please enter 1, 2, 3, or 4.');
    }
  } finally {
    rl.close();
  }
}

/**
 * Main repair routine. Reads settings, classifies, takes action per class.
 *
 * @param {object} [options]
 * @param {boolean} [options.force] - If true, non-interactively replace unknown-custom with telemetry
 * @param {boolean} [options.quiet] - Suppress non-essential logs
 * @returns {Promise<{action: string, class: string, changed: boolean}>}
 */
export async function repairStatusLine({ force = false, quiet = false } = {}) {
  const log = (msg) => { if (!quiet) console.log(msg); };
  const classification = classifyStatusLineFromFile(CLAUDE_SETTINGS_PATH);
  log(`  StatusLine classification: ${classification.class}${classification.reason ? ` (${classification.reason})` : ''}`);

  switch (classification.class) {
    case 'telemetry':
    case 'telemetry-wrapper': {
      log(`  StatusLine: healthy (${classification.class}) — no changes needed`);
      return { action: 'none', class: classification.class, changed: false };
    }

    case 'missing': {
      const { previousCommand, newCommand } = rewriteToTelemetry();
      appendHistoryEntry({
        action: 'install',
        from: previousCommand,
        to: newCommand,
        classifier: classification.class,
        reason: classification.reason,
      });
      log(`  StatusLine: installed telemetry forwarder`);
      return { action: 'install', class: classification.class, changed: true };
    }

    case 'placeholder': {
      const { previousCommand, newCommand } = rewriteToTelemetry();
      appendHistoryEntry({
        action: 'upgrade',
        from: previousCommand,
        to: newCommand,
        classifier: classification.class,
        reason: 'placeholder-detected',
      });
      log(`  StatusLine: auto-upgraded legacy placeholder to telemetry forwarder`);
      log(`    previous: ${previousCommand}`);
      return { action: 'upgrade', class: classification.class, changed: true };
    }

    case 'cli-only': {
      const { previousCommand, newCommand } = rewriteToTelemetry();
      appendHistoryEntry({
        action: 'upgrade',
        from: previousCommand,
        to: newCommand,
        classifier: classification.class,
        reason: 'cli-only-detected',
      });
      log(`  StatusLine: auto-upgraded CLI-only statusline to telemetry forwarder`);
      log(`    previous: ${previousCommand}`);
      return { action: 'upgrade', class: classification.class, changed: true };
    }

    case 'unknown-custom': {
      // Non-TTY without --force-statusline = safe default (no changes)
      if (!stdin.isTTY && !force) {
        log(`  StatusLine: custom script detected, non-interactive session — leaving unchanged.`);
        log(`    Run 'rh-telemetry repair-statusline' in a terminal to upgrade,`);
        log(`    or re-run with --force-statusline to replace non-interactively.`);
        return { action: 'skip-noninteractive', class: classification.class, changed: false };
      }

      if (force) {
        const { previousCommand, newCommand } = rewriteToTelemetry();
        appendHistoryEntry({
          action: 'replace',
          from: previousCommand,
          to: newCommand,
          classifier: classification.class,
          reason: 'force-flag',
        });
        log(`  StatusLine: replaced custom script (--force-statusline)`);
        return { action: 'replace', class: classification.class, changed: true };
      }

      const choice = await promptUnknownCustom(classification);

      if (choice === 'skip') {
        appendHistoryEntry({
          action: 'skip',
          from: classification.command,
          to: classification.command,
          classifier: classification.class,
          reason: 'user-skipped',
        });
        log(`  StatusLine: left unchanged. Dashboard will show degraded-mode banner.`);
        return { action: 'skip', class: classification.class, changed: false };
      }

      if (choice === 'replace') {
        const { previousCommand, newCommand } = rewriteToTelemetry();
        appendHistoryEntry({
          action: 'replace',
          from: previousCommand,
          to: newCommand,
          classifier: classification.class,
          reason: 'user-consent',
        });
        log(`  StatusLine: replaced with telemetry forwarder`);
        return { action: 'replace', class: classification.class, changed: true };
      }

      if (choice === 'wrap') {
        if (!classification.scriptPath || !existsSync(classification.scriptPath)) {
          log(`  StatusLine: cannot wrap — script path missing. Falling back to replace.`);
          const { previousCommand, newCommand } = rewriteToTelemetry();
          appendHistoryEntry({
            action: 'replace',
            from: previousCommand,
            to: newCommand,
            classifier: classification.class,
            reason: 'wrap-fallback-missing-script',
          });
          return { action: 'replace', class: classification.class, changed: true };
        }
        try {
          generateWrapper(classification.scriptPath, WRAPPER_OUTPUT_PATH);
        } catch (err) {
          log(`  StatusLine: wrapper generation failed (${err.message}). Falling back to replace.`);
          const { previousCommand, newCommand } = rewriteToTelemetry();
          appendHistoryEntry({
            action: 'replace',
            from: previousCommand,
            to: newCommand,
            classifier: classification.class,
            reason: `wrap-failed: ${err.message}`,
          });
          return { action: 'replace', class: classification.class, changed: true };
        }
        const { previousCommand, newCommand } = rewriteToWrapper(WRAPPER_OUTPUT_PATH);
        appendHistoryEntry({
          action: 'wrap',
          from: previousCommand,
          to: newCommand,
          classifier: classification.class,
          reason: 'user-consent',
        });
        log(`  StatusLine: wrapped original script — telemetry forwarding enabled`);
        log(`    wrapper: ${WRAPPER_OUTPUT_PATH}`);
        log(`    original preserved at: ${classification.scriptPath}`);
        return { action: 'wrap', class: classification.class, changed: true };
      }

      return { action: 'none', class: classification.class, changed: false };
    }

    default: {
      log(`  StatusLine: unknown classification '${classification.class}' — no action taken`);
      return { action: 'none', class: classification.class, changed: false };
    }
  }
}

// --- CLI entry point ---
// Run when invoked directly (not when imported as a module).
// Use pathToFileURL so the comparison matches import.meta.url's percent-encoding
// (e.g. spaces → %20). A hand-built `file://` string breaks on home paths that
// contain spaces or other URL-special characters (e.g. C:\Users\First Last).
const argv1 = process.argv[1] || '';
const isDirectInvocation = argv1 !== '' && import.meta.url === pathToFileURL(argv1).href;

if (isDirectInvocation) {
  const args = process.argv.slice(2);
  const force = args.includes('--force') || args.includes('--force-statusline');
  const quiet = args.includes('--quiet');
  repairStatusLine({ force, quiet })
    .then((result) => {
      if (!quiet) console.log(`\n  Result: ${result.action} (class=${result.class}, changed=${result.changed})`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(`[repair-statusline] Error: ${err.message}`);
      process.exit(1);
    });
}

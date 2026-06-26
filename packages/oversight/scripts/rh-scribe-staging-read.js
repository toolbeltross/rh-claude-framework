#!/usr/bin/env node
// rh-scribe-staging-read.js
//
// CLI helper for rh-scribe-multiscope (and /rh-quit). Reads the per-session
// staging file and prints the full ordered assistant text to stdout. Use this
// instead of (or in addition to) the 10K-char transcript tail when staging is
// enabled — gives the scribe full-session coverage.
//
// Usage:
//   node rh-scribe-staging-read.js <session-id>
//   node rh-scribe-staging-read.js <session-id> --json   # print raw JSONL records
//   node rh-scribe-staging-read.js <session-id> --stats  # print metadata only
//   node rh-scribe-staging-read.js <session-id> --clear  # delete after print
//
// Exit codes:
//   0  — printed text (or empty if no staging file)
//   1  — bad usage
//
// Origin: 2026-05-09 P1-3.

const staging = require('./lib/scribe-staging');

const args = process.argv.slice(2);
if (args.length < 1) {
  process.stderr.write('usage: rh-scribe-staging-read <session-id> [--json|--stats|--clear]\n');
  process.exit(1);
}

const sessionId = args[0];
const mode =
  args.includes('--json')  ? 'json'  :
  args.includes('--stats') ? 'stats' :
                             'text';
const clear = args.includes('--clear');

if (mode === 'json') {
  const records = staging.readSession(sessionId);
  process.stdout.write(JSON.stringify(records, null, 2) + '\n');
} else if (mode === 'stats') {
  const records = staging.readSession(sessionId);
  const totalChars = records.reduce((n, r) => n + (r?.chars || 0), 0);
  const truncated = records.filter(r => r?.truncated).length;
  process.stdout.write(JSON.stringify({
    sessionId,
    turns: records.length,
    totalChars,
    truncated,
    enabled: staging.isEnabled(),
    stagingPath: staging.stagingPath(sessionId),
  }, null, 2) + '\n');
} else {
  process.stdout.write(staging.readSessionText(sessionId));
  process.stdout.write('\n');
}

if (clear) staging.clearSession(sessionId);

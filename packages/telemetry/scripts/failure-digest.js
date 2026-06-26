#!/usr/bin/env node
/**
 * Failure Digest — generates a markdown summary of recent failures.
 *
 * Reads ~/.claude/telemetry-failures.jsonl, filters to a time period,
 * and either prints to stdout or appends to ~/.claude/telemetry-supervisory-log.md.
 *
 * Usage:
 *   node failure-digest.js              # last 24h, print to stdout
 *   node failure-digest.js --append     # last 24h, append to supervisory log
 *   node failure-digest.js --hours 48   # last 48h
 */
import { readFileSync, appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { FAILURE_LOG_PATH, SUPERVISORY_LOG_PATH } from '../server/config.js';

const SUPERVISORY_LOG = SUPERVISORY_LOG_PATH;

// Parse args
const args = process.argv.slice(2);
const shouldAppend = args.includes('--append');
const hoursIdx = args.indexOf('--hours');
const hours = hoursIdx >= 0 ? parseInt(args[hoursIdx + 1]) || 24 : 24;
const since = Date.now() - hours * 60 * 60 * 1000;

// Read JSONL
let records = [];
try {
  const content = readFileSync(FAILURE_LOG_PATH, 'utf-8');
  for (const line of content.split('\n').filter(Boolean)) {
    try { records.push(JSON.parse(line)); } catch {}
  }
} catch (err) {
  if (err.code === 'ENOENT') {
    console.log('No failure log found — no failures recorded yet.');
    process.exit(0);
  }
  console.error(`Error reading failure log: ${err.message}`);
  process.exit(1);
}

// Filter to time period
const recent = records.filter(r => r.timestamp >= since);

if (recent.length === 0) {
  console.log(`No failures in the last ${hours}h.`);
  process.exit(0);
}

// Analyze
const sessions = new Set(recent.map(r => r.sessionId).filter(Boolean));
const toolCounts = {};
const errorCounts = {};
for (const r of recent) {
  toolCounts[r.toolName] = (toolCounts[r.toolName] || 0) + 1;
  const errKey = (r.error || '').slice(0, 100);
  if (errKey) errorCounts[errKey] = (errorCounts[errKey] || 0) + 1;
}

const topTools = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]);
const topErrors = Object.entries(errorCounts).sort((a, b) => b[1] - a[1]);

// Generate markdown
const now = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
let md = `\n## Failure Digest — ${now}\n`;
md += `Period: last ${hours}h | Total: ${recent.length} failures | Sessions: ${sessions.size}\n\n`;

if (topTools.length > 0) {
  md += `### By Tool\n`;
  for (const [tool, count] of topTools.slice(0, 5)) {
    md += `- **${tool}**: ${count} failure${count > 1 ? 's' : ''}\n`;
  }
  md += '\n';
}

if (topErrors.length > 0) {
  md += `### Top Errors\n`;
  for (const [err, count] of topErrors.slice(0, 5)) {
    md += `- \`${err}\` (${count}x)\n`;
  }
  md += '\n';
}

// Recent failures (last 5)
md += `### Recent\n`;
for (const r of recent.slice(-5).reverse()) {
  const ts = r.isoTime ? r.isoTime.replace('T', ' ').replace(/\.\d+Z$/, '') : new Date(r.timestamp).toISOString();
  md += `- ${ts} | **${r.toolName}** | ${(r.error || '').slice(0, 80)} | \`${(r.sessionId || '').slice(0, 8)}\`\n`;
}
md += '\n---\n';

if (shouldAppend) {
  try {
    mkdirSync(dirname(SUPERVISORY_LOG), { recursive: true });
    appendFileSync(SUPERVISORY_LOG, md, 'utf-8');
    console.log(`Appended digest to ${SUPERVISORY_LOG}`);
  } catch (err) {
    console.error(`Error appending: ${err.message}`);
    process.exit(1);
  }
} else {
  process.stdout.write(md);
}
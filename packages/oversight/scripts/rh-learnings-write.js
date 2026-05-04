#!/usr/bin/env node
// rh-learnings-write.js — locked file-write helper for the rh-scribe-learnings agent.
//
// Phase 1 C2 (2026-05-02): closes concurrency exposure where parallel
// /rh-quit invocations could race on the same memory-shared/learnings/
// topic file or MEMORY.md indexes. Replaces the agent's prior direct
// Write-tool / Read+Write-tool calls with locked operations via
// lib/file-lock.js withLock().
//
// CLI:
//   node rh-learnings-write.js --mode <create|append-observation|update-sub-index|update-root-index>
// Payload: JSON via stdin.
//
// Modes:
//
//   create — new topic file. Payload schema:
//     {
//       topicFile: "<absolute path>",
//       name: "<human-readable name>",
//       description: "<one sentence>",
//       type: "project",
//       originSessionId: "<sid>",
//       created: "<ISO date>",
//       learning: "<2-6 sentence narrative>",
//       trigger: "<context>",
//       decisionRule: "<bulleted list, optional empty string>",
//       sourceSession: "<sid>",
//       sourceDate: "<ISO date>",
//       transcriptRef: "<location hint>"
//     }
//
//   append-observation — add row to existing topic file's ## Observations section.
//     {
//       topicFile: "<absolute path>",
//       dateIso: "<YYYY-MM-DD>",
//       sessionShort: "<8-char sid>",
//       observation: "<≤300 chars>"
//     }
//
//   update-sub-index — add/update topic row in learnings/MEMORY.md (with sentinel-hygiene).
//     {
//       indexFile: "<absolute path to learnings/MEMORY.md>",
//       topic: "<kebab-case topic>",
//       name: "<human-readable>",
//       lastUpdated: "<ISO date>"
//     }
//
//   update-root-index — update topic count in memory-shared/MEMORY.md.
//     {
//       indexFile: "<absolute path to memory-shared/MEMORY.md>",
//       topicCount: <integer>
//     }
//
// Output: JSON to stdout, e.g. {"ok": true, "mode": "create", "wrote": "<path>"}.
// Exits 0 on success, non-zero on validation/IO failure.

const fs = require('fs');
const path = require('path');
const { withLock } = require(path.join(__dirname, 'lib', 'file-lock'));
const { withPhase } = require(path.join(__dirname, 'lib', 'phase-timing'));

const SENTINEL = '<!-- scribe-done -->';

function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => buf += chunk);
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

function getArg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i < process.argv.length - 1 ? process.argv[i + 1] : null;
}

// --- create ---
function modeCreate(p) {
  const required = ['topicFile', 'name', 'description', 'originSessionId', 'created', 'learning', 'sourceSession', 'sourceDate'];
  for (const k of required) if (!p[k]) throw new Error(`create: missing ${k}`);

  const decisionRuleSection = (p.decisionRule && p.decisionRule.trim())
    ? `## Decision rule\n\n${p.decisionRule}\n\n`
    : '';
  const trigger = p.trigger || '';
  const transcriptRef = p.transcriptRef || '';
  const type = p.type || 'project';

  const body = `---
name: ${JSON.stringify(p.name)}
description: ${JSON.stringify(p.description)}
type: ${type}
originSessionId: ${p.originSessionId}
created: ${p.created}
---

## Learning

${p.learning}

## Trigger / context

${trigger}

${decisionRuleSection}## Source

- Session: ${p.sourceSession}
- Date: ${p.sourceDate}
- Transcript reference: ${transcriptRef}
${SENTINEL}
`;

  withLock(p.topicFile, () => {
    if (fs.existsSync(p.topicFile)) {
      throw new Error(`create: file already exists: ${p.topicFile} (use append-observation to add to existing)`);
    }
    fs.writeFileSync(p.topicFile, body, 'utf8');
  });
  return { ok: true, mode: 'create', wrote: p.topicFile };
}

// --- append-observation ---
function modeAppendObservation(p) {
  for (const k of ['topicFile', 'dateIso', 'sessionShort', 'observation']) {
    if (!p[k]) throw new Error(`append-observation: missing ${k}`);
  }
  const obs = p.observation.length > 300 ? p.observation.slice(0, 297) + '…' : p.observation;
  const row = `- ${p.dateIso} (session ${p.sessionShort}): ${obs}\n`;

  const result = withLock(p.topicFile, () => {
    if (!fs.existsSync(p.topicFile)) {
      throw new Error(`append-observation: file does not exist: ${p.topicFile}`);
    }
    let content = fs.readFileSync(p.topicFile, 'utf8');
    // Strip trailing sentinel (we'll re-add at end)
    const sentIdx = content.lastIndexOf(SENTINEL);
    if (sentIdx >= 0 && content.slice(sentIdx + SENTINEL.length).trim() === '') {
      content = content.slice(0, sentIdx).replace(/\n+$/, '\n');
    }
    // Find or create ## Observations section
    const obsMatch = content.match(/\n## Observations\s*\n/);
    let newContent;
    if (obsMatch) {
      // Append row at end of file (Observations section runs to end before sentinel)
      const tail = content.endsWith('\n') ? '' : '\n';
      newContent = content + tail + row;
    } else {
      // Add Observations section before final newline
      const tail = content.endsWith('\n') ? '' : '\n';
      newContent = content + tail + '\n## Observations\n\n' + row;
    }
    newContent = newContent.replace(/\n+$/, '\n') + SENTINEL + '\n';
    fs.writeFileSync(p.topicFile, newContent, 'utf8');
    return { rowAdded: row.trim() };
  });
  return { ok: true, mode: 'append-observation', wrote: p.topicFile, ...result };
}

// --- update-sub-index ---
// Schema: pipe-table with header "| topic | name | last-updated |".
// On match (topic exact equality in column 1), update the row. Else append.
// Sentinel-hygiene: scrub interior occurrences, keep one at EOF.
function modeUpdateSubIndex(p) {
  for (const k of ['indexFile', 'topic', 'name', 'lastUpdated']) {
    if (!p[k]) throw new Error(`update-sub-index: missing ${k}`);
  }
  const newRow = `| ${p.topic} | ${p.name.replace(/\|/g, '\\|')} | ${p.lastUpdated} |`;

  const result = withLock(p.indexFile, () => {
    let content;
    if (fs.existsSync(p.indexFile)) {
      content = fs.readFileSync(p.indexFile, 'utf8');
    } else {
      content = `# Learnings sub-index\n\nOne entry per topic file. Auto-populated by rh-scribe-learnings agent.\n\n| topic | name | last-updated |\n|---|---|---|\n`;
    }
    // Remove ALL sentinel occurrences (interior + EOF) — we'll re-add one at end.
    content = content.split('\n').filter(l => l.trim() !== SENTINEL).join('\n');
    // Find existing row by topic (column 1)
    const lines = content.split('\n');
    const topicEsc = p.topic.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rowRe = new RegExp(`^\\|\\s*${topicEsc}\\s*\\|`);
    let updated = false;
    for (let i = 0; i < lines.length; i++) {
      if (rowRe.test(lines[i])) {
        lines[i] = newRow;
        updated = true;
        break;
      }
    }
    if (!updated) {
      // Append after last existing data row (or after header separator)
      lines.push(newRow);
    }
    let newContent = lines.join('\n');
    if (!newContent.endsWith('\n')) newContent += '\n';
    newContent += SENTINEL + '\n';
    fs.writeFileSync(p.indexFile, newContent, 'utf8');
    return { action: updated ? 'updated' : 'appended', sentinelPosition: 'eof' };
  });
  return { ok: true, mode: 'update-sub-index', wrote: p.indexFile, ...result };
}

// --- update-root-index ---
// Update or insert: "- [Learnings index](learnings/MEMORY.md) — N topics; capability deltas captured per session"
function modeUpdateRootIndex(p) {
  for (const k of ['indexFile', 'topicCount']) {
    if (p[k] === undefined || p[k] === null) throw new Error(`update-root-index: missing ${k}`);
  }
  const expectedLine = `- [Learnings index](learnings/MEMORY.md) — ${p.topicCount} topics; capability deltas captured per session`;
  const lineRe = /^- \[Learnings index\]\(learnings\/MEMORY\.md\)/;

  const result = withLock(p.indexFile, () => {
    if (!fs.existsSync(p.indexFile)) {
      throw new Error(`update-root-index: file does not exist: ${p.indexFile}`);
    }
    const content = fs.readFileSync(p.indexFile, 'utf8');
    const lines = content.split('\n');
    let updated = false;
    for (let i = 0; i < lines.length; i++) {
      if (lineRe.test(lines[i])) {
        lines[i] = expectedLine;
        updated = true;
        break;
      }
    }
    if (!updated) {
      // Don't auto-insert into root MEMORY.md — its structure is hand-curated.
      // Caller must seed the line first. Return without modification + flag for caller.
      return { action: 'absent-not-inserted', expectedLine };
    }
    fs.writeFileSync(p.indexFile, lines.join('\n'), 'utf8');
    return { action: 'updated' };
  });
  return { ok: true, mode: 'update-root-index', wrote: p.indexFile, ...result };
}

(async () => {
  try {
    const mode = getArg('--mode');
    if (!mode) throw new Error('missing --mode (create|append-observation|update-sub-index|update-root-index)');
    const stdin = await readStdin();
    if (!stdin.trim()) throw new Error('empty stdin (expected JSON payload)');
    let payload;
    try { payload = JSON.parse(stdin); } catch (e) { throw new Error('invalid JSON payload: ' + e.message); }

    let result;
    // Phase-timing per mode (Phase 1 follow-on, 2026-05-02). Each mode does
    // its own withLock-bracketed read-modify-write; this records wall-clock
    // for that bracketed work to ~/.claude/phase-timing.jsonl.
    if (mode === 'create')                  result = withPhase('rh-learnings-write', 'mode:create', () => modeCreate(payload));
    else if (mode === 'append-observation') result = withPhase('rh-learnings-write', 'mode:append-observation', () => modeAppendObservation(payload));
    else if (mode === 'update-sub-index')   result = withPhase('rh-learnings-write', 'mode:update-sub-index', () => modeUpdateSubIndex(payload));
    else if (mode === 'update-root-index')  result = withPhase('rh-learnings-write', 'mode:update-root-index', () => modeUpdateRootIndex(payload));
    else throw new Error(`unknown mode: ${mode}`);

    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(0);
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: e.message }) + '\n');
    process.exit(1);
  }
})();

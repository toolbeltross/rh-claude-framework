// read-audit.js
// PostToolUse:Read + PostToolUse:mcp__pdf-reader__read_pdf hook.
// Logs every read to ~/.claude/session-reads.log AND, for F-06, surfaces a
// non-blocking warning when a Read returns partial content from a > 800-line
// file with no offset/limit (per Workspace/.claude/rules/rh-read-integrity.md
// the threshold above which direct reads in main context become unreliable).
// The warning is rate-limited to once-per-file-per-session to avoid nag noise.

const fs = require('fs');
const path = require('path');
const { wrapHook } = require('./lib/hook-timing');
const { config } = require('./lib/config');

// Resolve under ~/.claude via config (HOME || USERPROFILE || os.homedir()). The
// previous `process.env.USERPROFILE + '/.claude/...'` was undefined on macOS/
// Linux — it wrote to a literal "undefined/.claude/..." dir, silently disabling
// the F-06 truncation audit off-Windows.
const LOG_PATH = path.join(config.claudeDir, 'session-reads.log');
const WARN_MARKER_DIR = path.join(config.claudeDir, 'read-warn-markers');
const TRUNCATION_THRESHOLD_LINES = 800;

function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

function shouldWarnOnce(filePath) {
  try {
    if (!fs.existsSync(WARN_MARKER_DIR)) fs.mkdirSync(WARN_MARKER_DIR, { recursive: true });
    const safeName = filePath.replace(/[\\/:*?"<>|]/g, '_').slice(0, 200);
    const marker = path.join(WARN_MARKER_DIR, `${todayStamp()}_${safeName}.warn`);
    if (fs.existsSync(marker)) return false;
    fs.writeFileSync(marker, '', 'utf8');
    return true;
  } catch { return false; }
}

function countLinesIfReasonable(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > 5 * 1024 * 1024) return Infinity;
    const content = fs.readFileSync(filePath, 'utf8');
    return content.split(/\r?\n/).length;
  } catch { return null; }
}

wrapHook('read-audit', (input) => {
  const toolName = input?.tool_name || 'unknown';
  const ti = input?.tool_input || {};
  const timestamp = new Date().toISOString();

  let entry;
  let warning = null;

  if (toolName === 'Read') {
    const filepath = ti.file_path || 'unknown';
    const offset = ti.offset || 0;
    const limit = ti.limit || 'default(2000)';
    entry = `${timestamp} | READ | offset:${offset} limit:${limit} | ${filepath}\n`;

    if (filepath !== 'unknown' && offset === 0 && (limit === 'default(2000)' || limit === 2000)) {
      const totalLines = countLinesIfReasonable(filepath);
      if (totalLines !== null && totalLines > TRUNCATION_THRESHOLD_LINES) {
        if (shouldWarnOnce(filepath)) {
          warning = `[read-audit] ${filepath} has ${totalLines === Infinity ? '> 5MB worth of' : totalLines} lines (threshold ${TRUNCATION_THRESHOLD_LINES}). Direct Read in main context returns partial content. Per read-integrity.md, dispatch a subagent or use offset/limit reads. Suppressing further warnings for this file today.`;
        }
      }
    }
  } else if (toolName === 'mcp__pdf-reader__read_pdf') {
    const sources = Array.isArray(ti.sources) ? ti.sources : [];
    const urls = sources.map(s => s?.url || s?.path || '?').join(';');
    const pages = ti.pages || 'all';
    const to = (input?.tool_output || input?.tool_result || '').toString();
    const m = to.match(/"(?:num_pages|total_pages|page_count|numPages|totalPages)"\s*:\s*(\d+)/i)
           || to.match(/of\s+(\d+)\s+pages?/i)
           || to.match(/(\d+)\s+pages?\s+total/i);
    const respPages = m ? m[1] : '?';
    entry = `${timestamp} | PDF  | requested:${pages} sources:${sources.length} resp_pages:${respPages} | ${urls}\n`;
  } else {
    // CRITICAL size bound (Phase 1 C3, 2026-05-02): .slice(0, 200) keeps
    // entry well under the NTFS sub-block atomicity bound (~4KB). DO NOT
    // remove this slice — toolInput can carry user content of arbitrary size.
    entry = `${timestamp} | ${toolName} | ${JSON.stringify(ti).slice(0, 200)}\n`;
  }

  // JSONL atomic-append assumption: unlocked because Windows NTFS guarantees
  // atomicity for sub-block writes (~4KB). Entry is bounded by the
  // .slice(0, 200) above on toolInput. If you remove or relax that slice,
  // switch to lib/file-lock.js withLock instead of bare appendFileSync.
  try { fs.appendFileSync(LOG_PATH, entry, 'utf8'); } catch {}

  if (warning) {
    process.stderr.write(warning + '\n');
    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: warning,
      }
    };
  }

  return {};
}, { hookType: 'PostToolUse', matcher: 'Read' });

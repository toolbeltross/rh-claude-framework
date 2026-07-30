#!/usr/bin/env node
/**
 * rh-context-surface.js
 *
 * UserPromptSubmit hook — injects a one-line LIVE context-usage reminder so the
 * assistant can apply rh-context-discipline bands against a REAL measured number
 * instead of guessing (the gap that caused a bad "context unmeasurable" call
 * 2026-06-06).
 *
 * WHY transcript-parsing (not direct read): hook stdin does NOT include token
 * usage — verified 2026-06-06 against https://code.claude.com/docs/en/hooks
 * (only the statusLine hook receives context_window). But stdin DOES include
 * `transcript_path`, and the transcript records per-message usage. Verified
 * structure: message.usage = {input_tokens, cache_read_input_tokens,
 * cache_creation_input_tokens, ...}. Effective context ≈ their sum on the last
 * assistant message.
 *
 * WINDOW SIZE: from CLAUDE_CONTEXT_WINDOW_SIZE (the framework's own documented
 * override; set to 1000000 for this 1M Opus model) → else 200000 default.
 * Deliberately does NOT guess 1M from a model name — a 200K-tier user must not
 * be mis-told 1M (matches resolveContextWindowSize "never guesses").
 *
 * Non-blocking: any error → emit "{}" and exit 0.
 */
const fs = require("fs");

function readStdin() { try { return fs.readFileSync(0, "utf8"); } catch { return ""; } }

function lastUsage(transcriptPath) {
  const lines = fs.readFileSync(transcriptPath, "utf8").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i]; if (!ln.trim()) continue;
    let o; try { o = JSON.parse(ln); } catch { continue; }
    const u = o && o.message && o.message.usage;
    if (u) return u;
  }
  return null;
}

// rh-context-discipline.md bands, expressed in REMAINING tokens.
function band(remaining) {
  if (remaining < 15000) return "HALT — do not start anything new (<15K remaining)";
  if (remaining < 40000) return "STOP taking new work; complete only the current task (<40K)";
  if (remaining < 80000) return "LOW — finish current task, recommend a new session soon (<80K)";
  if (remaining < 150000) return "note — getting full; avoid starting large new tasks (<150K)";
  return "healthy";
}

try {
  const raw = readStdin();
  const input = raw ? JSON.parse(raw) : {};
  const tp = input.transcript_path;
  if (!tp || !fs.existsSync(tp)) { process.stdout.write("{}"); process.exit(0); }
  const u = lastUsage(tp);
  if (!u) { process.stdout.write("{}"); process.exit(0); }
  const used = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  const envWin = parseInt(process.env.CLAUDE_CONTEXT_WINDOW_SIZE, 10);
  const win = envWin > 0 ? envWin : 200000;
  const remaining = Math.max(0, win - used);
  const pct = Math.round((used / win) * 100);
  const k = (n) => Math.round(n / 1000) + "K";
  const ctx = `Live context: ~${k(used)}/${k(win)} tokens used (${pct}%), ~${k(remaining)} remaining — ${band(remaining)}.`;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: ctx },
  }));
} catch {
  try { process.stdout.write("{}"); } catch {}
}
process.exit(0);

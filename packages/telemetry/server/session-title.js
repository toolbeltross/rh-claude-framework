/**
 * Deterministic, no-LLM session-title derivation.
 *
 * The Claude Code IDE shows a short, LLM-generated title per session in its
 * "Recents" list (e.g. "Dashboard working directory"). Those titles are NOT
 * stored anywhere the telemetry server can read (verified 2026-06-15: not in
 * ~/.claude.json, not as `type:"summary"` transcript entries, not in
 * session-marker files, not in ~/.claude/ide/). They live in the app's own
 * storage. So we approximate them from the thing they're generated from: the
 * session's FIRST substantive user prompt, which IS in every transcript.
 *
 * This is a heuristic by design (the user explicitly ruled out an LLM in the
 * server). It produces a decent 3–5 word title for direct human prompts and
 * returns `null` for structured/automated/preamble prompts (scheduled tasks,
 * path-leading prompts, slash-commands) so the caller can fall back to the
 * existing "project (id-slice)" label rather than render something mangled.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');

// sessionId -> string | null. Only populated once a session's transcript has a
// readable first prompt; "not ready yet" returns undefined and is NOT cached so
// a freshly-started session is retried until its first prompt lands.
const _cache = new Map();

// Leading conversational filler stripped before picking title words.
const FILLER = /^(ok|okay|so|well|hi|hey|please|thanks|can you|could you|i want to|i'?d like to|i would like to|i need to|is this|is the|are these|are the|should we|should i|do you|does the|what'?s|what is|what are|how (do|does|can|should)|let'?s|now|just|actually|then|and|but)\b[\s,]*/i;

/**
 * Turn a raw first-prompt string into a short title, or null if it doesn't make
 * a sensible one (caller should fall back to the project label).
 * Pure function — unit-tested directly.
 */
export function deriveTitle(text) {
  if (!text || typeof text !== 'string') return null;
  let t = text.trim();
  if (!t) return null;

  // Reject structured / automated / non-prose prompts → fall back to project label.
  if (t.startsWith('/') || t.startsWith('<') || t.startsWith('{') || t.startsWith('[')) return null;
  if (/^(today\s*=|local context\b|use the \w+ tool\b|in [\w.-]+ \(|run |execute )/i.test(t)) return null;
  if (/system-reminder|Caveat:|<command-name>/i.test(t.slice(0, 120))) return null;
  // Reject prompts whose opening is dominated by a filesystem path or URL.
  if (/([a-z]:[\\/]|https?:\/\/|\/[a-z]+\/[a-z]+\/)/i.test(t.slice(0, 30))) return null;

  // Strip code spans / markdown noise, collapse whitespace.
  t = t.replace(/`[^`]*`/g, ' ').replace(/[#*_>`~]/g, ' ').replace(/\s+/g, ' ').trim();

  // Strip leading filler iteratively ("is this the right..." -> "right...").
  let prev;
  do { prev = t; t = t.replace(FILLER, '').trim(); } while (t !== prev);

  // Cut at the first sentence boundary so a title never runs across clauses
  // ("oversight system working correctly? (if we..." -> "oversight system working correctly").
  const sentenceEnd = t.search(/[.?!]/);
  if (sentenceEnd > 2) t = t.slice(0, sentenceEnd);

  const words = t.split(' ').filter(Boolean).slice(0, 6);
  let s = words.join(' ');
  if (!s) return null;
  if (s.length > 40) s = s.slice(0, 38).replace(/\s\S*$/, '') + '…';
  s = s.replace(/[?.!,:;]+$/, '').trim();
  if (s.replace(/[…\s]/g, '').length < 3) return null; // too short to be meaningful

  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Read the first substantive user message from a transcript JSONL file. */
function firstPromptFromTranscript(file) {
  const raw = readFileSync(file, 'utf8');
  const lines = raw.split('\n');
  for (const line of lines) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'user' || !o.message) continue;
    const c = o.message.content;
    let txt = typeof c === 'string' ? c : (Array.isArray(c) ? c.map((x) => x.text || '').join(' ') : '');
    txt = (txt || '').trim();
    if (!txt) continue;
    // skip tool-result / meta user turns
    if (txt.startsWith('<') || /^Caveat:/i.test(txt) || /tool_result/i.test(txt.slice(0, 40))) continue;
    return txt;
  }
  return '';
}

/** Locate a session's transcript by id (glob across project slugs). */
function findTranscript(sessionId) {
  let slugs;
  try { slugs = readdirSync(PROJECTS_DIR); } catch { return null; }
  for (const slug of slugs) {
    const f = join(PROJECTS_DIR, slug, `${sessionId}.jsonl`);
    if (existsSync(f)) return f;
  }
  return null;
}

/**
 * Title for a session, or null to use the fallback label.
 * Returns `undefined` when the transcript isn't readable yet (caller should
 * leave the field unset and retry on a later snapshot).
 */
export function getSessionTitle(sessionId) {
  if (!sessionId) return null;
  if (_cache.has(sessionId)) return _cache.get(sessionId);
  let file;
  try { file = findTranscript(sessionId); } catch { return undefined; }
  if (!file) return undefined; // transcript not present yet
  let prompt;
  try { prompt = firstPromptFromTranscript(file); } catch { return undefined; }
  if (!prompt) return undefined; // no first prompt captured yet — retry later
  const title = deriveTitle(prompt);
  _cache.set(sessionId, title); // string | null — both are terminal
  return title;
}

/** Test hook. */
export function _clearTitleCache() { _cache.clear(); }

#!/usr/bin/env node
/**
 * rh-transcript-ingest.js — incremental Claude Code transcript ingestion
 * into the rh_scribe postgres database for full-text search.
 * PLAN-2026-06-11-scribe-postgres-fts.md Phase 3.
 *
 * Scans <claudeDir>/projects/<slug>/<session>.jsonl, extracts user/assistant
 * TEXT messages (tool blobs skipped), and bulk-inserts into
 * transcript_messages. Incremental: transcripts.ingested_through stores the
 * byte offset already processed per session; re-runs resume from there
 * (offsets always land on line boundaries because we record the full file
 * size after a complete pass).
 *
 * Privacy: project slugs matching ~/.claude/private-blocklist.json patterns
 * (path-scoped, '/'→'-' normalized) or the framework's built-in Personal- /
 * Financial- markers are skipped and counted, never ingested. The DB is
 * local-only and sits in the same trust domain as the transcript files
 * themselves.
 *
 * Usage:
 *   node rh-transcript-ingest.js [--dry-run] [--full] [--project <slug>] [--stats]
 *                                [--projects-dir <path>] [--slug-prefix <p>]
 *     --projects-dir  ingest an alternate projects tree (e.g. an archived
 *                     machine's .claude/projects) instead of the live one
 *     --slug-prefix   prefix stored project_slug values (e.g. "centrifuge:")
 *                     so corpora stay distinguishable
 *     --dry-run  list what would be ingested, write nothing
 *     --full     forget offsets and re-ingest everything (delete + reinsert)
 *     --project  restrict to one project slug
 *     --stats    print DB counts and exit
 *
 * No-op (exit 0, message) unless config.scribeDb is true.
 */

const fs = require('fs');
const path = require('path');
const { config } = require('./lib/config');
const scribeDb = require('./lib/scribe-db');
const { estimateCost } = require('./lib/cost-rates');
// Telemetry capture (Phase 3.5) — best-effort, contextDb-gated. Defensive require
// so an older install missing these libs can't break transcript FTS ingest.
let contextDb, telemetry;
try {
  contextDb = require('./lib/context-db');
  telemetry = require('./lib/transcript-telemetry');
} catch {
  contextDb = null; telemetry = null;
}

const ARGS = process.argv.slice(2);
const DRY = ARGS.includes('--dry-run');
const FULL = ARGS.includes('--full');
const STATS = ARGS.includes('--stats');
const ONLY_PROJECT = ARGS.includes('--project') ? ARGS[ARGS.indexOf('--project') + 1] : null;
const PROJECTS_DIR_OVERRIDE = ARGS.includes('--projects-dir') ? ARGS[ARGS.indexOf('--projects-dir') + 1] : null;
const SLUG_PREFIX = ARGS.includes('--slug-prefix') ? ARGS[ARGS.indexOf('--slug-prefix') + 1] : '';

const BATCH_ROWS = 200;          // rows per INSERT statement
const MAX_MSG_CHARS = 500000;    // clamp pathological messages

function loadBlockPatterns() {
  const builtin = ['personal-', 'financial-'];
  try {
    const j = JSON.parse(fs.readFileSync(path.join(config.claudeDir, 'private-blocklist.json'), 'utf8'));
    const fromFile = (j.patterns || []).map(p => String(p).replace(/[\\/]+/g, '-').toLowerCase());
    return builtin.concat(fromFile);
  } catch { return builtin; }
}

function slugBlocked(slug, patterns) {
  const s = ('-' + slug + '-').toLowerCase();
  return patterns.some(p => s.includes('-' + p.replace(/^-+|-+$/g, '') + '-') || s.includes(p));
}

/** Extract plain text from a transcript JSONL line; null if not a text message. */
function extractMessage(line) {
  let j;
  try { j = JSON.parse(line); } catch { return null; }
  if (j.type !== 'user' && j.type !== 'assistant') return null;
  const msg = j.message;
  if (!msg) return null;
  let text = '';
  if (typeof msg.content === 'string') text = msg.content;
  else if (Array.isArray(msg.content)) {
    text = msg.content.filter(b => b && b.type === 'text' && b.text).map(b => b.text).join('\n');
  }
  text = text.trim();
  if (!text) return null;
  const out = { role: j.type, ts: j.timestamp || null, text: text.slice(0, MAX_MSG_CHARS) };
  // Per-turn telemetry (Phase 3.5): enrich assistant text rows with usage from
  // the same line. Cost is estimated (transcript carries no per-line cost).
  if (j.type === 'assistant' && msg.usage) {
    const u = msg.usage;
    out.input_tokens = u.input_tokens || 0;
    out.output_tokens = u.output_tokens || 0;
    out.cache_read = u.cache_read_input_tokens || 0;
    out.cache_write = u.cache_creation_input_tokens || 0;
    out.model = msg.model || null;
    out.tool_calls = Array.isArray(msg.content) ? msg.content.filter(b => b && b.type === 'tool_use').length : 0;
    out.cost_usd = out.model ? estimateCost(out.model, { input: out.input_tokens, output: out.output_tokens, cacheRead: out.cache_read, cacheWrite: out.cache_write }) : null;
  }
  return out;
}

// withTelemetry adds the per-turn columns (Phase 3.5). Only enable when
// contextDb is on — those columns are added by the ctx_ schema, which a
// scribeDb-only install may not have applied.
function sqlBatchInsert(sessionId, startTurn, msgs, withTelemetry) {
  const baseCols = ['session_id', 'turn', 'role', 'ts', 'content'];
  const telCols = ['input_tokens', 'output_tokens', 'cache_read', 'cache_write', 'cost_usd', 'tool_calls'];
  const cols = withTelemetry ? baseCols.concat(telCols) : baseCols;
  const intLit = v => (v == null ? 'NULL' : String(v | 0));
  const values = msgs.map((m, i) => {
    const v = [
      scribeDb.dollarQuote(sessionId),
      String(startTurn + i),
      scribeDb.dollarQuote(m.role),
      m.ts ? scribeDb.dollarQuote(m.ts) + '::timestamptz' : 'NULL',
      scribeDb.dollarQuote(m.text),
    ];
    if (withTelemetry) {
      v.push(
        intLit(m.input_tokens), intLit(m.output_tokens), intLit(m.cache_read), intLit(m.cache_write),
        m.cost_usd == null ? 'NULL' : Number(m.cost_usd).toFixed(6),
        intLit(m.tool_calls),
      );
    }
    return '(' + v.join(',') + ')';
  }).join(',\n');
  return `INSERT INTO transcript_messages (${cols.join(', ')}) VALUES\n${values};`;
}

function ingestFile(slug, file, sessionIdOverride, opts = {}) {
  const sessionId = sessionIdOverride || path.basename(file, '.jsonl');
  const size = fs.statSync(file).size;
  const withTelemetry = !!(config.contextDb && contextDb && telemetry);

  // Offset/turn come from a preloaded map (opts.offsets) so the incremental
  // pass issues ONE psql query for all sessions instead of one per file (the
  // per-file SELECT made the read-only floor scale with file count — ~56s at
  // 380 files on Windows, where psql cold-start dominates). Falls back to a
  // per-file SELECT when no map is supplied (direct callers, or a failed bulk
  // load) so the function stays correct standalone.
  let offset = 0, turn = 0, hadPrev = false;
  if (opts.offsets instanceof Map) {
    const rec = opts.offsets.get(sessionId);
    if (rec) {
      hadPrev = true;
      offset = FULL ? 0 : rec.ingested_through;
      turn = FULL ? 0 : rec.message_count;
    }
  } else {
    const prev = scribeDb.runSql(
      `SELECT ingested_through || '|' || message_count FROM transcripts WHERE session_id=${scribeDb.dollarQuote(sessionId)};`
    );
    if (!prev.ok) return { sessionId, error: prev.error };
    if (prev.stdout) {
      hadPrev = true;
      const [o, c] = prev.stdout.split('|');
      offset = FULL ? 0 : parseInt(o, 10) || 0;
      turn = FULL ? 0 : parseInt(c, 10) || 0;
    }
  }
  if (offset >= size) return { sessionId, skipped: 'up-to-date' };

  const buf = fs.readFileSync(file);
  const chunk = buf.slice(offset).toString('utf8');
  const msgs = [];
  for (const line of chunk.split('\n')) {
    const m = extractMessage(line);
    if (m) msgs.push(m);
  }

  if (DRY) return { sessionId, wouldIngest: msgs.length, fromOffset: offset };

  // Upsert transcript header first (FK target), reset on --full.
  const tsFirst = msgs.length && msgs[0].ts ? scribeDb.dollarQuote(msgs[0].ts) + '::timestamptz' : 'NULL';
  const tsLast = msgs.length && msgs[msgs.length - 1].ts ? scribeDb.dollarQuote(msgs[msgs.length - 1].ts) + '::timestamptz' : 'NULL';
  const header = (FULL && hadPrev
    ? `DELETE FROM transcript_messages WHERE session_id=${scribeDb.dollarQuote(sessionId)};\n`
    : '') +
    `INSERT INTO transcripts (session_id, project_slug, path, first_ts, last_ts, message_count, ingested_through)
     VALUES (${scribeDb.dollarQuote(sessionId)}, ${scribeDb.dollarQuote(slug)}, ${scribeDb.dollarQuote(file)}, ${tsFirst}, ${tsLast}, 0, 0)
     ON CONFLICT (session_id) DO UPDATE SET last_ts = COALESCE(EXCLUDED.last_ts, transcripts.last_ts)${FULL ? ', message_count = 0, ingested_through = 0' : ''};`;
  let res = scribeDb.runSql(header, 10000);
  if (!res.ok) return { sessionId, error: res.error };

  for (let i = 0; i < msgs.length; i += BATCH_ROWS) {
    const batch = msgs.slice(i, i + BATCH_ROWS);
    res = scribeDb.runSql(sqlBatchInsert(sessionId, turn + i, batch, withTelemetry), 60000);
    if (!res.ok) return { sessionId, error: res.error, partialAt: turn + i };
  }

  res = scribeDb.runSql(
    `UPDATE transcripts SET ingested_through=${size}, message_count=${turn + msgs.length}, ingested_at=now() WHERE session_id=${scribeDb.dollarQuote(sessionId)};`
  );
  if (!res.ok) return { sessionId, error: res.error };

  // Part B (Phase 3.5): aggregate the FULL transcript into ctx_ telemetry.
  // Best-effort, contextDb-gated, never blocks the FTS ingest above. Full-file
  // (not just the new chunk) so session/subagent totals are complete; the
  // session writer is idempotent so re-ingests refresh rather than duplicate.
  if (withTelemetry) {
    try {
      const records = telemetry.parseTranscriptTelemetry(buf.toString('utf8'));
      if (opts.isSubagent) {
        contextDb.upsertSubagentRun(
          telemetry.aggregateSubagentRun(records, { agent_id: sessionId, parent_session_id: opts.parentSessionId, agent_type: opts.agentType })
        );
      } else {
        const agg = telemetry.aggregateSession(records);
        contextDb.writeSessionTelemetry({ session_id: sessionId, modelUsage: agg.modelUsage, snapshot: agg.snapshot });
      }
    } catch { /* best-effort; never block ingest */ }
  }
  return { sessionId, ingested: msgs.length };
}

function main() {
  if (STATS) {
    const r = scribeDb.runSql("SELECT (SELECT count(*) FROM transcripts) || ' transcripts, ' || (SELECT count(*) FROM transcript_messages) || ' messages';");
    console.log(r.ok ? r.stdout : `error: ${r.error}`);
    return;
  }
  if (!config.scribeDb) {
    console.log('scribeDb flag is off (oversight.json scribeDb:true to enable) — nothing to do.');
    return;
  }
  const projectsDir = PROJECTS_DIR_OVERRIDE || path.join(config.claudeDir, 'projects');
  if (!fs.existsSync(projectsDir)) { console.log('no projects dir'); return; }

  const patterns = loadBlockPatterns();
  const summary = { projects: 0, files: 0, ingested: 0, upToDate: 0, blockedProjects: 0, errors: [] };

  // Bulk-load every stored offset in ONE query instead of one psql spawn per
  // transcript file. On Windows psql cold-start (~150ms) dominated, so the
  // per-file SELECT made the incremental pass scale with file count (~56s at
  // 380 files) and overran the daily-regen step timeout. One query keeps the
  // floor flat. Best-effort: on any failure `offsets` stays null and ingestFile
  // falls back to its per-file SELECT, preserving the old behavior exactly.
  let offsets = null;
  {
    const r = scribeDb.runSql(
      "SELECT coalesce(json_agg(json_build_object('s', session_id, 'o', ingested_through, 'm', message_count)), '[]'::json) FROM transcripts;",
      30000
    );
    if (r.ok) {
      try {
        offsets = new Map(
          JSON.parse(r.stdout || '[]').map(x => [x.s, {
            ingested_through: parseInt(x.o, 10) || 0,
            message_count: parseInt(x.m, 10) || 0,
          }])
        );
      } catch { offsets = null; }
    }
  }

  for (const slug of fs.readdirSync(projectsDir)) {
    const dir = path.join(projectsDir, slug);
    if (!fs.statSync(dir).isDirectory()) continue;
    if (ONLY_PROJECT && slug !== ONLY_PROJECT) continue;
    if (slugBlocked(slug, patterns)) { summary.blockedProjects++; continue; }
    summary.projects++;
    for (const f of fs.readdirSync(dir)) {
      const fp = path.join(dir, f);
      if (f.endsWith('.jsonl')) {
        summary.files++;
        const r = ingestFile(SLUG_PREFIX + slug, fp, undefined, { offsets });
        if (r.error) summary.errors.push(`${r.sessionId}: ${r.error}`);
        else if (r.skipped) summary.upToDate++;
        else summary.ingested += r.ingested || r.wouldIngest || 0;
        continue;
      }
      // Subagent transcripts live at <session>/subagents/agent-*.jsonl.
      const subDir = path.join(fp, 'subagents');
      if (fs.statSync(fp).isDirectory() && fs.existsSync(subDir)) {
        for (const sf of fs.readdirSync(subDir)) {
          if (!sf.endsWith('.jsonl')) continue;
          summary.files++;
          const r = ingestFile(SLUG_PREFIX + slug, path.join(subDir, sf), f + ':' + path.basename(sf, '.jsonl'), { isSubagent: true, parentSessionId: f, offsets });
          if (r.error) summary.errors.push(`${r.sessionId}: ${r.error}`);
          else if (r.skipped) summary.upToDate++;
          else summary.ingested += r.ingested || r.wouldIngest || 0;
        }
      }
    }
  }
  console.log(JSON.stringify({ dryRun: DRY || undefined, ...summary, errors: summary.errors.slice(0, 5) }, null, 1));
  if (summary.errors.length) process.exitCode = 1;
}

if (require.main === module) main();
module.exports = { extractMessage, slugBlocked, loadBlockPatterns, sqlBatchInsert };

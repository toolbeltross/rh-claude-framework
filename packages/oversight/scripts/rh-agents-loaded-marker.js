// agents-loaded-marker.js
// SessionStart hook (added 2026-04-29).
// Writes ~/.claude/session-marker-{sid}.json capturing the moment-in-time view of
// which agent files exist on disk + their mtimes when the session started. Other
// hooks (notably scribe-prefilter.js) read this marker to detect whether an agent
// they want to dispatch was actually present at session start — agents created
// mid-session are NOT loaded into the runtime's available list, so dispatching
// them is a dead-end that produces hot loops.
//
// Marker schema:
//   { sessionId, startedAt: ISO, agents: { <name>: <mtime ISO> } }
//
// Cleanup: markers are stale-aged at 30 days by daily-regen.js (any sid whose
// startedAt is > 30 days old gets deleted). Until that's wired, manual cleanup
// is fine — files are tiny.

const fs = require('fs');
const path = require('path');
const { wrapHook } = require('./lib/hook-timing');
const { config } = require('./lib/config');

const AGENTS_DIR = path.join(config.claudeDir, 'agents');

function listAgents() {
  const out = {};
  try {
    const files = fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md'));
    for (const f of files) {
      try {
        const full = path.join(AGENTS_DIR, f);
        const stat = fs.statSync(full);
        // Use the filename (without .md) as the agent name. The frontmatter `name:`
        // field is canonical, but parsing YAML adds complexity. Filename ≈ name in
        // practice; if a future agent uses a non-matching name, update consumers.
        const name = f.replace(/\.md$/, '');
        out[name] = new Date(stat.mtimeMs).toISOString();
      } catch {}
    }
  } catch {}
  return out;
}

function markerPath(sessionId) {
  const safe = (sessionId || 'nosid').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64);
  return path.join(config.claudeDir, `session-marker-${safe}.json`);
}

wrapHook('agents-loaded-marker', (input) => {
  const sessionId = input?.session_id || '';
  const fp = markerPath(sessionId);

  // If marker already exists for this session (resume), keep the original startedAt
  // but refresh the agent list so consumers can detect post-resume agent additions.
  let startedAt = new Date().toISOString();
  try {
    const existing = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (existing?.startedAt) startedAt = existing.startedAt;
  } catch {}

  const marker = {
    sessionId,
    startedAt,
    agents: listAgents(),
  };

  try { fs.writeFileSync(fp, JSON.stringify(marker, null, 2), 'utf8'); } catch {}

  return {};
}, { hookType: 'SessionStart' });

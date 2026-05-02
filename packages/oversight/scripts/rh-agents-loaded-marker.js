// agents-loaded-marker.js
// SessionStart hook — writes session-marker-{sid}.json capturing which agents
// exist on disk when the session started.

const fs = require('fs');
const path = require('path');
const { wrapHook } = require('./lib/hook-timing');
const { config } = require('./lib/config');

function listAgents() {
  const out = {};
  try {
    const files = fs.readdirSync(config.agentsDir).filter(f => f.endsWith('.md'));
    for (const f of files) {
      try {
        const full = path.join(config.agentsDir, f);
        const stat = fs.statSync(full);
        out[f.replace(/\.md$/, '')] = new Date(stat.mtimeMs).toISOString();
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

  let startedAt = new Date().toISOString();
  try {
    const existing = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (existing?.startedAt) startedAt = existing.startedAt;
  } catch {}

  const marker = { sessionId, startedAt, agents: listAgents() };

  try { fs.writeFileSync(fp, JSON.stringify(marker, null, 2), 'utf8'); } catch {}

  return {};
}, { hookType: 'SessionStart' });

/**
 * Claude Code Desktop session-title bridge.
 *
 * CCD keeps one JSON per session under
 *   %APPDATA%/Claude/claude-code-sessions/<org>/<project>/local_*.json
 * carrying `cliSessionId` (the transcript session id every other telemetry
 * source keys on) and `title` (the human English title shown in the Desktop
 * sidebar). Joining the two lets dashboard surfaces label sessions the same
 * way the Desktop app does.
 *
 * Read-only, best-effort: on CLI-only machines (or non-Windows without
 * APPDATA) the directory is absent and this returns an empty map — callers
 * fall back to their existing labels.
 */
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

const CCD_SESSIONS_DIR = join(
  process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'),
  'Claude',
  'claude-code-sessions'
);

const TTL_MS = 10_000;
let cache = { at: 0, byCliId: {} };

async function scan() {
  const byCliId = {};
  let orgs;
  try {
    orgs = await readdir(CCD_SESSIONS_DIR, { withFileTypes: true });
  } catch {
    return byCliId; // no Desktop app on this machine — empty map
  }
  for (const org of orgs) {
    if (!org.isDirectory()) continue;
    const orgPath = join(CCD_SESSIONS_DIR, org.name);
    let projects;
    try {
      projects = await readdir(orgPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const proj of projects) {
      if (!proj.isDirectory()) continue;
      const projPath = join(orgPath, proj.name);
      let files;
      try {
        files = await readdir(projPath);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.startsWith('local_') || !f.endsWith('.json')) continue;
        try {
          const o = JSON.parse(await readFile(join(projPath, f), 'utf8'));
          if (!o?.cliSessionId || !o?.title) continue;
          byCliId[o.cliSessionId] = {
            title: o.title,
            ccdSessionId: o.sessionId || null,
            isArchived: Boolean(o.isArchived),
            prNumber: o.prNumber ?? null,
            prState: o.prState ?? null,
            lastActivityAt: o.lastActivityAt ?? null,
          };
        } catch {
          continue; // unreadable/corrupt session file — skip
        }
      }
    }
  }
  return byCliId;
}

/** TTL-cached map: transcript sessionId → { title, prNumber, prState, ... } */
export async function getCcdSessionTitles() {
  const now = Date.now();
  if (now - cache.at > TTL_MS) {
    cache = { at: now, byCliId: await scan() };
  }
  return cache.byCliId;
}

export { CCD_SESSIONS_DIR };

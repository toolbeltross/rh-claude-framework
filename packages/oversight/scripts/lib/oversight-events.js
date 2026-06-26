// oversight-events.js — structured event log for oversight enforcement decisions.
// Writes to the path resolved by config.js (default: ~/.claude/oversight-events.jsonl).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { config } = require('./config');

function getLogPath() {
  return config.eventsLogPath;
}

function appendOversightEvent(eventType, data) {
  if (process.env.OVERSIGHT_SELF_TEST === '1') return;

  try {
    const safeData = data || {};
    const dataStr = JSON.stringify(safeData, Object.keys(safeData).sort());
    const contentHash = crypto.createHash('sha256').update(dataStr).digest('hex');
    const event = {
      timestamp: new Date().toISOString(),
      event_type: eventType,
      data: safeData,
      content_hash: contentHash,
    };
    const logPath = getLogPath();
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify(event) + '\n', 'utf8');
  } catch {}
}

module.exports = { appendOversightEvent, getLogPath };

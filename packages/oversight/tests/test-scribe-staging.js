// Unit tests for lib/scribe-staging.js — per-session offset-delta staging.
//
// P1-3 (2026-05-09): replaces the silent 10K-tail truncation with a per-turn
// staging file that captures the exact transcript-bytes appended since the
// previous Stop. Tests cover the plan's required scenario (30K-char synthetic
// turn → all captured at session end) plus offset advancement, caps, JSONL
// roundtrip, env-flag gating, and pruning.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate the test from the user's real ~/.claude/. The lib reads config at
// require-time, so we must set CLAUDE_DIR + clear the cached config BEFORE
// requiring the lib for the first time.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-scribe-staging-test-'));
process.env.CLAUDE_DIR = TMP_ROOT;
process.env.CLAUDE_WORKSPACE = TMP_ROOT;
// Default to OFF for the env-flag test; individual tests flip as needed.
delete process.env.RH_SCRIBE_STAGING;

const { resetCache } = require('../scripts/lib/config');
resetCache();
const staging = require('../scripts/lib/scribe-staging');

// Helper: write a synthetic JSONL transcript chunk. Each call appends a single
// "assistant" message line containing `text`. Returns the new file size.
function appendAssistantTurn(transcriptPath, text) {
  const line = JSON.stringify({
    message: { role: 'assistant', content: [{ type: 'text', text }] }
  }) + '\n';
  fs.appendFileSync(transcriptPath, line, 'utf8');
  return fs.statSync(transcriptPath).size;
}

function appendUserTurn(transcriptPath, text) {
  const line = JSON.stringify({
    message: { role: 'user', content: text }
  }) + '\n';
  fs.appendFileSync(transcriptPath, line, 'utf8');
  return fs.statSync(transcriptPath).size;
}

function freshTranscript(name) {
  const fp = path.join(TMP_ROOT, name);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  fs.writeFileSync(fp, '', 'utf8');
  return fp;
}

const tests = [
  {
    name: 'P1-3 required scenario — 30K-char synthetic turn survives staging end-to-end',
    fn: () => {
      const sid = 'sess-30k';
      const transcript = freshTranscript('transcript-30k.jsonl');
      // Single 30K assistant turn — bigger than the 10K tail cap.
      const bigText = 'X'.repeat(30_000);
      appendAssistantTurn(transcript, bigText);

      const delta = staging.readDelta(transcript, sid);
      assert.strictEqual(delta.advanced, true, 'delta should advance from offset 0');
      const text = staging.extractAssistantText(delta.text);
      assert.strictEqual(text, bigText, 'extracted assistant text should match input verbatim');

      staging.appendTurn(sid, text);
      staging.writeOffset(sid, delta.newOffset);

      const all = staging.readSessionText(sid);
      assert.strictEqual(all.length, 30_000, `expected 30000 chars in staging, got ${all.length}`);
      assert.strictEqual(all, bigText, 'staging file should contain the entire turn');

      // Cleanup
      staging.clearSession(sid);
      assert.strictEqual(staging.readSessionText(sid), '', 'clear should remove staging file');
    }
  },
  {
    name: 'offset advances per turn — multi-turn session has zero overlap and zero gap',
    fn: () => {
      const sid = 'sess-multi';
      const transcript = freshTranscript('transcript-multi.jsonl');

      // Turn 1
      appendUserTurn(transcript, 'first user question');
      appendAssistantTurn(transcript, 'A1: turn one response');
      let d = staging.readDelta(transcript, sid);
      assert.strictEqual(d.advanced, true);
      let t = staging.extractAssistantText(d.text);
      assert.strictEqual(t, 'A1: turn one response');
      staging.appendTurn(sid, t);
      staging.writeOffset(sid, d.newOffset);

      // Turn 2
      appendUserTurn(transcript, 'second user question');
      appendAssistantTurn(transcript, 'A2: turn two response');
      d = staging.readDelta(transcript, sid);
      assert.strictEqual(d.advanced, true);
      t = staging.extractAssistantText(d.text);
      assert.strictEqual(t, 'A2: turn two response', 'turn 2 delta should contain ONLY turn 2 assistant text');
      staging.appendTurn(sid, t);
      staging.writeOffset(sid, d.newOffset);

      // Turn 3
      appendUserTurn(transcript, 'third');
      appendAssistantTurn(transcript, 'A3: third');
      d = staging.readDelta(transcript, sid);
      staging.appendTurn(sid, staging.extractAssistantText(d.text));
      staging.writeOffset(sid, d.newOffset);

      const records = staging.readSession(sid);
      assert.strictEqual(records.length, 3, `expected 3 turns staged, got ${records.length}`);
      assert.deepStrictEqual(
        records.map(r => r.text),
        ['A1: turn one response', 'A2: turn two response', 'A3: third'],
        'turns should be staged in order with no overlap'
      );

      staging.clearSession(sid);
    }
  },
  {
    name: 'no-op when no new bytes — second readDelta with no transcript change returns advanced:false',
    fn: () => {
      const sid = 'sess-noop';
      const transcript = freshTranscript('transcript-noop.jsonl');
      appendAssistantTurn(transcript, 'something');
      const d1 = staging.readDelta(transcript, sid);
      staging.writeOffset(sid, d1.newOffset);
      const d2 = staging.readDelta(transcript, sid);
      assert.strictEqual(d2.advanced, false, 'no new bytes → advanced=false');
      assert.strictEqual(d2.text, '', 'no new bytes → empty text');
      staging.clearSession(sid);
    }
  },
  {
    name: 'transcript shrink → offset resets to 0 (size-smaller-than-prior case)',
    fn: () => {
      const sid = 'sess-shrink';
      const transcript = freshTranscript('transcript-shrink.jsonl');
      // Build a longish transcript first
      appendAssistantTurn(transcript, 'A'.repeat(500));
      appendAssistantTurn(transcript, 'B'.repeat(500));
      const d1 = staging.readDelta(transcript, sid);
      staging.writeOffset(sid, d1.newOffset, transcript);
      // Now truncate to something MUCH smaller — realistic shrink scenario
      // (transcript rotated, wiped externally, or recreated).
      fs.writeFileSync(transcript, '');
      appendAssistantTurn(transcript, 'recovered');
      const d2 = staging.readDelta(transcript, sid);
      assert.strictEqual(d2.advanced, true, 'shrink should advance from offset 0');
      const t = staging.extractAssistantText(d2.text);
      assert.strictEqual(t, 'recovered', 'should read the entire recovered file from start');
      staging.clearSession(sid);
    }
  },
  {
    name: 'per-turn cap enforced — turn > TURN_CHAR_CAP is truncated, marker preserved',
    fn: () => {
      const sid = 'sess-turncap';
      const huge = 'Y'.repeat(staging.TURN_CHAR_CAP + 10_000);
      const written = staging.appendTurn(sid, huge);
      assert.strictEqual(written, staging.TURN_CHAR_CAP + '\n…[truncated at TURN_CHAR_CAP]'.length,
        'written length should equal cap + truncation marker length');
      const records = staging.readSession(sid);
      assert.strictEqual(records.length, 1);
      assert.strictEqual(records[0].truncated, true, 'truncated flag should be set');
      assert.ok(records[0].text.startsWith('Y'), 'text should start with content');
      assert.ok(records[0].text.includes('[truncated at TURN_CHAR_CAP]'), 'marker should be present');
      staging.clearSession(sid);
    }
  },
  {
    name: 'session file cap enforced — appendTurn returns 0 once file is at/above cap',
    fn: () => {
      const sid = 'sess-filecap';
      // Pre-seed the staging file to just over the cap (write a giant JSONL line directly).
      const fp = staging.stagingPath(sid);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, 'X'.repeat(staging.SESSION_FILE_CAP + 100));
      const written = staging.appendTurn(sid, 'should-be-rejected');
      assert.strictEqual(written, 0, 'append should be rejected when file already over cap');
      staging.clearSession(sid);
    }
  },
  {
    name: 'isEnabled() — env var "1" overrides config; "0" overrides config; unset falls back to config',
    fn: () => {
      const { resetCache } = require('../scripts/lib/config');

      delete process.env.RH_SCRIBE_STAGING;
      resetCache();
      // Re-require staging to pick up fresh config. Module is cached, so we
      // can't just re-require; isEnabled() itself reads process.env and
      // config.scribeStaging live, so cache-busting config is enough.
      // Without config flag set and env unset → true (on by default).
      // We can't set config.scribeStaging without writing oversight.json;
      // assert the env path here and let the config path be covered by a
      // separate scenario.
      assert.strictEqual(staging.isEnabled(), true, 'env unset + no config → true (default on)');

      process.env.RH_SCRIBE_STAGING = '1';
      assert.strictEqual(staging.isEnabled(), true, 'env=1 → true');

      process.env.RH_SCRIBE_STAGING = '0';
      assert.strictEqual(staging.isEnabled(), false, 'env=0 → false (override)');

      delete process.env.RH_SCRIBE_STAGING;
    }
  },
  {
    name: 'isEnabled() — oversight.json scribeStaging:true is honored when env unset',
    fn: () => {
      const { resetCache, CONFIG_PATH } = require('../scripts/lib/config');
      delete process.env.RH_SCRIBE_STAGING;
      const cfgDir = path.dirname(CONFIG_PATH);
      fs.mkdirSync(cfgDir, { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify({ scribeStaging: true }), 'utf8');
      resetCache();
      // Force lib/scribe-staging to re-read by reloading via require.cache bust.
      delete require.cache[require.resolve('../scripts/lib/scribe-staging')];
      const fresh = require('../scripts/lib/scribe-staging');
      assert.strictEqual(fresh.isEnabled(), true, 'config flag should enable when env unset');
      // Restore: clear scribeStaging so subsequent tests see the default (on).
      fs.writeFileSync(CONFIG_PATH, JSON.stringify({}), 'utf8');
      resetCache();
    }
  },
  {
    name: 'pruneStale() removes staging+offset files older than maxAgeMs',
    fn: () => {
      const sid = 'sess-old';
      staging.appendTurn(sid, 'old content');
      staging.writeOffset(sid, 1234);
      const fp = staging.stagingPath(sid);
      const op = staging.offsetPath(sid);
      assert.ok(fs.existsSync(fp), 'staging file should exist');
      assert.ok(fs.existsSync(op), 'offset file should exist');

      // Backdate both
      const oldTime = Date.now() / 1000 - 8 * 24 * 60 * 60;
      fs.utimesSync(fp, oldTime, oldTime);
      fs.utimesSync(op, oldTime, oldTime);

      const result = staging.pruneStale(7 * 24 * 60 * 60 * 1000);
      assert.strictEqual(result.stagingRemoved, 1, 'one staging file removed');
      assert.strictEqual(result.offsetRemoved, 1, 'one offset file removed');
      assert.strictEqual(fs.existsSync(fp), false);
      assert.strictEqual(fs.existsSync(op), false);
    }
  },
  {
    name: 'readSession returns [] when no staging file exists',
    fn: () => {
      assert.deepStrictEqual(staging.readSession('never-existed'), []);
      assert.strictEqual(staging.readSessionText('never-existed'), '');
    }
  },
  {
    name: 'JSONL records are well-formed and round-trip via readSession()',
    fn: () => {
      const sid = 'sess-rt';
      staging.appendTurn(sid, 'turn A', { hasRec: true, hasCleanup: false });
      staging.appendTurn(sid, 'turn B', { hasRec: false, hasCleanup: true });
      const records = staging.readSession(sid);
      assert.strictEqual(records.length, 2);
      assert.strictEqual(records[0].text, 'turn A');
      assert.strictEqual(records[0].hasRec, true);
      assert.strictEqual(records[1].text, 'turn B');
      assert.strictEqual(records[1].hasCleanup, true);
      assert.ok(records[0].ts, 'records should have ts field');
      assert.ok(records[0].chars > 0, 'records should have chars field');
      staging.clearSession(sid);
    }
  },
  {
    name: 'safeSid() sanitizes session IDs — special chars stripped, length capped',
    fn: () => {
      const sid = 'evil/../sid\x00with\nnewlines';
      // appendTurn should not throw, and file should land in stagingDir
      staging.appendTurn(sid, 'safe content');
      const fp = staging.stagingPath(sid);
      assert.ok(fp.startsWith(staging.stagingDir()), 'staging path must stay inside staging dir');
      assert.ok(!fp.includes('..'), 'no path traversal');
      assert.ok(!fp.includes('\x00'), 'no null byte');
      staging.clearSession(sid);
    }
  },
];

module.exports = { tests };

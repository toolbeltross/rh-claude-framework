// Unit tests for rh-supervisor-sweep.js.
//
// Plan P3-1 test mechanism: "7-day window of synthetic events → trend doc
// generated correctly | Fixture + cron-style test".

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-sweep-test-'));

const sweep = require('../scripts/rh-supervisor-sweep');

function jsonlEvent(ts, type, data = {}) {
  return JSON.stringify({ timestamp: ts, event_type: type, data, content_hash: 'h' });
}

function isoMinus(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

const tests = [
  // ── parseArgs ──────────────────────────────────────────────────────────
  {
    name: 'parseArgs — defaults: 7-day window, no json/dry-run',
    fn: () => {
      const o = sweep.parseArgs([]);
      assert.strictEqual(o.days, 7);
      assert.strictEqual(o.json, false);
      assert.strictEqual(o.dryRun, false);
    }
  },
  {
    name: 'parseArgs — --days N parsed, --json + --dry-run flags',
    fn: () => {
      const o = sweep.parseArgs(['--days', '30', '--json', '--dry-run']);
      assert.strictEqual(o.days, 30);
      assert.strictEqual(o.json, true);
      assert.strictEqual(o.dryRun, true);
    }
  },
  {
    name: 'parseArgs — non-numeric --days throws',
    fn: () => {
      assert.throws(() => sweep.parseArgs(['--days', 'nope']), /positive integer/);
    }
  },

  // ── readEvents ─────────────────────────────────────────────────────────
  {
    name: 'readEvents — missing file returns fileMissing:true with empty events',
    fn: () => {
      const r = sweep.readEvents(path.join(TMP, 'nope.jsonl'), 0, Date.now());
      assert.strictEqual(r.fileMissing, true);
      assert.deepStrictEqual(r.events, []);
    }
  },
  {
    name: 'readEvents — filters events outside [windowStart, windowEnd]',
    fn: () => {
      const fp = path.join(TMP, 'window.jsonl');
      const now = Date.now();
      fs.writeFileSync(fp, [
        jsonlEvent(new Date(now - 8 * 86400000).toISOString(), 'old'),       // outside (older)
        jsonlEvent(new Date(now - 3 * 86400000).toISOString(), 'in-window'), // inside
        jsonlEvent(new Date(now - 1 * 86400000).toISOString(), 'in-window'), // inside
        jsonlEvent(new Date(now + 86400000).toISOString(), 'future'),        // outside (future)
      ].join('\n'));
      const r = sweep.readEvents(fp, now - 7 * 86400000, now);
      assert.strictEqual(r.events.length, 2);
      assert.deepStrictEqual(r.events.map(e => e.event_type), ['in-window', 'in-window']);
    }
  },
  {
    name: 'readEvents — malformed lines are skipped silently',
    fn: () => {
      const fp = path.join(TMP, 'mixed.jsonl');
      const now = Date.now();
      fs.writeFileSync(fp, [
        'not json',
        jsonlEvent(new Date(now - 1 * 86400000).toISOString(), 'valid'),
        '{broken',
        '',
        jsonlEvent('not-a-date', 'bad-ts'),  // unparseable timestamp → skipped
      ].join('\n'));
      const r = sweep.readEvents(fp, now - 7 * 86400000, now);
      assert.strictEqual(r.events.length, 1);
    }
  },

  // ── readLayer3aRejections ──────────────────────────────────────────────
  {
    name: 'readLayer3aRejections — parses canonical line format, filters window',
    fn: () => {
      const fp = path.join(TMP, 'sup-log.md');
      const now = Date.now();
      const inside = new Date(now - 2 * 86400000).toISOString().replace('T', ' ').replace(/\..*$/, '');
      const outside = new Date(now - 30 * 86400000).toISOString().replace('T', ' ').replace(/\..*$/, '');
      fs.writeFileSync(fp,
        `# Supervisory Log\n` +
        `- **${outside}** | \`old-sid\` | Layer3a-rejection | ancient rule\n` +
        `- **${inside}** | \`fresh-sid\` | Layer3a-rejection | Rule 3 violation\n` +
        `- some unrelated line\n`
      );
      const r = sweep.readLayer3aRejections(fp, now - 7 * 86400000, now);
      assert.strictEqual(r.rejections.length, 1);
      assert.strictEqual(r.rejections[0].sid, 'fresh-sid');
      assert.ok(r.rejections[0].reason.includes('Rule 3'));
    }
  },
  {
    name: 'readLayer3aRejections — missing file returns fileMissing:true',
    fn: () => {
      const r = sweep.readLayer3aRejections(path.join(TMP, 'no-log.md'), 0, Date.now());
      assert.strictEqual(r.fileMissing, true);
      assert.deepStrictEqual(r.rejections, []);
    }
  },

  // ── aggregate ──────────────────────────────────────────────────────────
  {
    name: 'aggregate — counts events by type, day, session',
    fn: () => {
      const now = Date.now();
      const t = (d) => now - d * 86400000;
      const events = [
        { _ts: t(1), event_type: 'oversight_auto_inject', data: { session_id: 'sA', missing_elements: ['verificationToken', 'contextReport'] } },
        { _ts: t(1), event_type: 'oversight_auto_inject', data: { session_id: 'sA', missing_elements: ['verificationToken'] } },
        { _ts: t(2), event_type: 'consolidation_blocked', data: { session_id: 'sB' } },
        { _ts: t(3), event_type: 'instructions_loaded', data: { session_id: 'sB' } },
      ];
      const agg = sweep.aggregate(events, [], now - 7 * 86400000, now);
      assert.strictEqual(agg.total, 4);
      // byType sorted desc
      assert.deepStrictEqual(agg.byType[0], ['oversight_auto_inject', 2]);
      // missingElements aggregated across events
      const mMap = new Map(agg.missingElements);
      assert.strictEqual(mMap.get('verificationToken'), 2);
      assert.strictEqual(mMap.get('contextReport'), 1);
      // bySid limited to top 5, sorted desc
      assert.strictEqual(agg.bySid[0][0], 'sA');
      assert.strictEqual(agg.bySid[0][1], 2);
    }
  },
  {
    name: 'aggregate — empty events returns total:0 and empty arrays',
    fn: () => {
      const agg = sweep.aggregate([], [], 0, Date.now());
      assert.strictEqual(agg.total, 0);
      assert.deepStrictEqual(agg.byType, []);
      assert.deepStrictEqual(agg.byDay, []);
    }
  },
  {
    name: 'aggregate — Layer3a rejections counted by day + by sid',
    fn: () => {
      const now = Date.now();
      const rejections = [
        { ts: now - 86400000, sid: 'sX', reason: 'r1' },
        { ts: now - 86400000, sid: 'sX', reason: 'r2' },
        { ts: now - 2 * 86400000, sid: 'sY', reason: 'r3' },
      ];
      const agg = sweep.aggregate([], rejections, now - 7 * 86400000, now);
      assert.strictEqual(agg.layer3aRejections, 3);
      const sidMap = new Map(agg.rejectBySid);
      assert.strictEqual(sidMap.get('sX'), 2);
      assert.strictEqual(sidMap.get('sY'), 1);
    }
  },

  // ── renderMarkdown ─────────────────────────────────────────────────────
  {
    name: 'renderMarkdown — contains header + summary + window dates',
    fn: () => {
      const now = Date.now();
      const agg = sweep.aggregate([
        { _ts: now - 86400000, event_type: 'oversight_auto_inject', data: { session_id: 's1' } },
      ], [], now - 7 * 86400000, now);
      const md = sweep.renderMarkdown(agg, null, { days: 7 });
      assert.ok(md.includes('# Supervisor Trends'));
      assert.ok(md.includes('**Window:**'));
      assert.ok(md.includes('Oversight events'));
      assert.ok(md.includes('oversight_auto_inject'));
    }
  },
  {
    name: 'renderMarkdown — prior window delta shown when priorAgg provided',
    fn: () => {
      const now = Date.now();
      const curAgg = sweep.aggregate([
        { _ts: now - 86400000, event_type: 'X', data: { session_id: 's1' } },
        { _ts: now - 86400000, event_type: 'X', data: { session_id: 's1' } },
      ], [], now - 7 * 86400000, now);
      const priorAgg = sweep.aggregate([
        { _ts: now - 10 * 86400000, event_type: 'X', data: { session_id: 's2' } },
      ], [], now - 14 * 86400000, now - 7 * 86400000);
      const md = sweep.renderMarkdown(curAgg, priorAgg, { days: 7 });
      assert.ok(md.includes('+1'), 'expected delta +1 in markdown');
    }
  },
  {
    name: 'renderMarkdown — empty window shows "_No events in window._"',
    fn: () => {
      const agg = sweep.aggregate([], [], 0, Date.now());
      const md = sweep.renderMarkdown(agg, null, { days: 7 });
      assert.ok(md.includes('_No events in window._'));
    }
  },
  {
    name: 'renderMarkdown — daily cadence ASCII bar chart present',
    fn: () => {
      const now = Date.now();
      const agg = sweep.aggregate(
        Array.from({ length: 5 }, (_, i) => ({
          _ts: now - (i + 1) * 86400000,
          event_type: 'X',
          data: { session_id: 's' + i },
        })),
        [], now - 7 * 86400000, now
      );
      const md = sweep.renderMarkdown(agg, null, { days: 7 });
      assert.ok(md.includes('```'), 'expected code-block fences for cadence');
      assert.ok(md.includes('█') || md.includes('·'), 'expected bar chart glyph');
    }
  },

  // ── formatDelta ────────────────────────────────────────────────────────
  {
    name: 'formatDelta — null → em-dash, 0 → "0", positive → "+N"',
    fn: () => {
      assert.strictEqual(sweep.formatDelta(null), '—');
      assert.strictEqual(sweep.formatDelta(undefined), '—');
      assert.strictEqual(sweep.formatDelta(0), '0');
      assert.strictEqual(sweep.formatDelta(5), '+5');
      assert.strictEqual(sweep.formatDelta(-3), '-3');
    }
  },

  // ── End-to-end via run() ───────────────────────────────────────────────
  {
    name: 'P3-1 plan scenario — 7-day synthetic events generate complete trend doc',
    fn: () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-e2e-'));
      const eventsPath = path.join(tmpHome, 'oversight-events.jsonl');
      const logPath = path.join(tmpHome, 'supervisory-log.md');
      const outPath = path.join(tmpHome, 'trends.md');

      const now = Date.now();
      const events = [];
      // 7 days worth, mixed event types
      for (let d = 0; d < 7; d++) {
        events.push(jsonlEvent(new Date(now - d * 86400000).toISOString(), 'oversight_auto_inject', {
          session_id: 'sess' + (d % 3),
          missing_elements: d % 2 ? ['verificationToken'] : ['contextReport', 'verificationToken'],
        }));
      }
      // Also include 14d-old prior-window events
      for (let d = 8; d < 13; d++) {
        events.push(jsonlEvent(new Date(now - d * 86400000).toISOString(), 'instructions_loaded', {
          session_id: 'old-sess',
        }));
      }
      fs.writeFileSync(eventsPath, events.join('\n'));
      // Synthetic Layer3a rejection in window
      const ts = new Date(now - 2 * 86400000).toISOString().replace('T', ' ').replace(/\..*$/, '');
      fs.writeFileSync(logPath,
        `- **${ts}** | \`hot-sess\` | Layer3a-rejection | Rule 3 noise\n`
      );

      const code = sweep.run([
        '--days', '7',
        '--events', eventsPath,
        '--supervisory-log', logPath,
        '--out', outPath,
      ]);
      assert.strictEqual(code, 0);
      assert.ok(fs.existsSync(outPath), 'trend doc must be written');
      const md = fs.readFileSync(outPath, 'utf8');

      // Plan-specified verifications: the doc reflects the synthetic data
      assert.ok(md.includes('# Supervisor Trends'));
      assert.ok(md.includes('oversight_auto_inject'), 'event type in summary');
      assert.ok(md.includes('verificationToken'), 'missing-element pattern surfaced');
      assert.ok(md.includes('hot-sess'), 'Layer3a-rejection session surfaced');
      // Prior-window delta should reference instructions_loaded (5 in prior, 0 in current)
      // → appears as a row with prior > 0 even though current is 0; that's fine.
      // Just confirm the doc has a Summary section showing 7 events.
      assert.ok(/Oversight events.*\|\s*7\s*\|/.test(md), `expected "Oversight events | 7" row, got:\n${md.slice(0, 1500)}`);
    }
  },
  {
    name: 'run --dry-run — does not write file, prints to stdout',
    fn: () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-dry-'));
      const eventsPath = path.join(tmpHome, 'e.jsonl');
      const outPath = path.join(tmpHome, 'should-not-exist.md');
      fs.writeFileSync(eventsPath, jsonlEvent(new Date().toISOString(), 'oversight_auto_inject', { session_id: 's' }));

      const captured = [];
      const orig = process.stdout.write.bind(process.stdout);
      process.stdout.write = (c) => { captured.push(c.toString()); return true; };
      let code;
      try {
        code = sweep.run(['--dry-run', '--events', eventsPath, '--out', outPath, '--supervisory-log', '/nonexistent']);
      } finally {
        process.stdout.write = orig;
      }
      assert.strictEqual(code, 0);
      assert.strictEqual(fs.existsSync(outPath), false, 'file must NOT be written in dry-run');
      assert.ok(captured.join('').includes('Supervisor Trends'), 'expected markdown on stdout');
    }
  },
  {
    name: 'run --json — emits parseable JSON with current+prior aggs',
    fn: () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-json-'));
      const eventsPath = path.join(tmpHome, 'e.jsonl');
      const outPath = path.join(tmpHome, 'trends.json');
      fs.writeFileSync(eventsPath, jsonlEvent(new Date().toISOString(), 'X', { session_id: 's' }));

      const code = sweep.run(['--json', '--events', eventsPath, '--out', outPath, '--supervisory-log', '/nonexistent']);
      assert.strictEqual(code, 0);
      const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      assert.ok(parsed.current && parsed.prior, 'JSON must have current and prior keys');
      assert.strictEqual(parsed.current.total, 1);
    }
  },
];

module.exports = { tests };

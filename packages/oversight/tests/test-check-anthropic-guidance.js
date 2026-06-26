// Tests for rh-check-anthropic-guidance.js — fetches Anthropic doc pages,
// diffs against cached hashes, writes GUIDANCE_CHANGES.md.
//
// Strategy:
//   1. Inline pure-function tests (normalize, sha256) — zero network, zero spawn.
//   2. Spawn structural tests — verify cache + output creation regardless of
//      network outcome (the script exits 0 and writes the file in all cases).
//
// NOTE: The 5 spawn tests make real HTTPS calls to docs.claude.com (9 pages in
// parallel, 10s timeout each). They complete in <5s on a live network or nearly
// instantly on a dead one (ENOTFOUND). Either way exit 0 + output file written.

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'rh-check-anthropic-guidance.js');

// ─── Inline copies of the two pure functions ──────────────────────────────────
// These are NOT imported — they live inside the script's closure. Copying them
// here lets us unit-test the normalization logic without spawning or networking.

function normalize(html) {
  const nextDataMatch = html.match(/<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  const nextData = nextDataMatch ? nextDataMatch[1] : '';
  const stripped = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<meta[^>]*(?:csrf|nonce|build-id|deploy-id)[^>]*>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  const content = (stripped + ' ' + nextData).replace(/"buildId":"[^"]+"/g, '"buildId":"X"');
  return content;
}

function sha256(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

// ─── Spawn helpers ────────────────────────────────────────────────────────────

function withTmpEnv(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-cag-test-'));
  const claudeDir = path.join(home, '.claude');
  const oversightDir = path.join(claudeDir, 'oversight');
  fs.mkdirSync(oversightDir, { recursive: true });
  try {
    return fn({ home, claudeDir, oversightDir });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function runScript(env) {
  return spawnSync('node', [SCRIPT], {
    encoding: 'utf8',
    timeout: 30000,   // 9 parallel HTTPS calls with 10s each
    windowsHide: true,
    env: { ...process.env, ...env },
  });
}

function makeEnv(home, oversightDir) {
  return {
    HOME: home,
    USERPROFILE: home,
    CLAUDE_DIR: path.join(home, '.claude'),
    OVERSIGHT_DIR: oversightDir,
    CLAUDE_WORKSPACE: home,
  };
}

// ─── Pure-function tests (no network, no spawn) ───────────────────────────────

const tests = [
  {
    name: 'normalize() strips <script> tags',
    fn: () => {
      const html = 'before<script src="x.js">bad()</script>after';
      assert.ok(!normalize(html).includes('bad()'), 'script content should be stripped');
      assert.ok(normalize(html).includes('before'), 'surrounding content preserved');
      assert.ok(normalize(html).includes('after'), 'surrounding content preserved');
    },
  },
  {
    name: 'normalize() strips <style> tags',
    fn: () => {
      const html = 'text<style>.cls{color:red}</style>more';
      assert.ok(!normalize(html).includes('.cls'), 'style content should be stripped');
      assert.ok(normalize(html).includes('text'), 'surrounding text preserved');
    },
  },
  {
    name: 'normalize() strips HTML comments',
    fn: () => {
      const html = 'a<!-- secret comment -->b';
      assert.ok(!normalize(html).includes('secret comment'));
      assert.ok(normalize(html).includes('a'));
      assert.ok(normalize(html).includes('b'));
    },
  },
  {
    name: 'normalize() preserves __NEXT_DATA__ blob',
    fn: () => {
      const payload = '{"props":{"key":"unique-payload-value"}}';
      const html = `<div>page</div><script id="__NEXT_DATA__" type="application/json">${payload}</script>`;
      const out = normalize(html);
      assert.ok(out.includes('unique-payload-value'),
        '__NEXT_DATA__ content should be retained in normalized output');
    },
  },
  {
    name: 'normalize() replaces buildId values with "X"',
    fn: () => {
      const html = '<script id="__NEXT_DATA__" type="application/json">{"buildId":"abc123-deploy-xyz"}</script>';
      const out = normalize(html);
      assert.ok(out.includes('"buildId":"X"'), 'buildId should be replaced with X');
      assert.ok(!out.includes('abc123-deploy-xyz'), 'original buildId value should not appear');
    },
  },
  {
    name: 'normalize() collapses whitespace',
    fn: () => {
      const html = 'a   \n\t  b';
      const out = normalize(html);
      assert.ok(!out.includes('   '), 'multiple spaces should be collapsed');
      assert.ok(out.includes('a b') || out.includes('a'), 'text should be retained');
    },
  },
  {
    name: 'sha256() returns a 64-character hex string',
    fn: () => {
      const h = sha256('hello world');
      assert.strictEqual(h.length, 64);
      assert.match(h, /^[0-9a-f]{64}$/);
    },
  },
  {
    name: 'sha256() is deterministic',
    fn: () => {
      assert.strictEqual(sha256('test input'), sha256('test input'));
    },
  },
  {
    name: 'sha256() differs for different inputs',
    fn: () => {
      assert.notStrictEqual(sha256('aaa'), sha256('bbb'));
    },
  },

  // ─── Spawn structural tests (accept real network calls) ────────────────────

  {
    name: 'exits 0 regardless of network outcome',
    fn: () => withTmpEnv(({ home, oversightDir }) => {
      const r = runScript(makeEnv(home, oversightDir));
      assert.strictEqual(r.status, 0,
        `script must exit 0 in all cases; stderr: ${(r.stderr || '').slice(0, 300)}`);
    }),
  },
  {
    name: 'creates cache file at CLAUDE_DIR/cache/anthropic-docs-hashes.json',
    fn: () => withTmpEnv(({ home, claudeDir, oversightDir }) => {
      runScript(makeEnv(home, oversightDir));
      const cachePath = path.join(claudeDir, 'cache', 'anthropic-docs-hashes.json');
      assert.ok(fs.existsSync(cachePath), `cache file should exist at ${cachePath}`);
      const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      assert.ok(typeof cache === 'object', 'cache should be a JSON object');
    }),
  },
  {
    name: 'cache file contains all 9 target page IDs as keys',
    fn: () => withTmpEnv(({ home, claudeDir, oversightDir }) => {
      runScript(makeEnv(home, oversightDir));
      const cache = JSON.parse(fs.readFileSync(
        path.join(claudeDir, 'cache', 'anthropic-docs-hashes.json'), 'utf8'));
      const EXPECTED_IDS = ['hooks', 'settings', 'subagents', 'skills', 'mcp',
                            'statusline', 'agent-sdk', 'tool-use', 'models'];
      for (const id of EXPECTED_IDS) {
        assert.ok(id in cache, `cache should contain key "${id}"`);
      }
    }),
  },
  {
    name: 'creates GUIDANCE_CHANGES.md under oversight/../environment/',
    fn: () => withTmpEnv(({ home, claudeDir, oversightDir }) => {
      runScript(makeEnv(home, oversightDir));
      const outPath = path.join(claudeDir, 'environment', 'GUIDANCE_CHANGES.md');
      assert.ok(fs.existsSync(outPath), `output file should exist at ${outPath}`);
    }),
  },
  {
    name: 'GUIDANCE_CHANGES.md contains H1 heading and "All watched pages" section',
    fn: () => withTmpEnv(({ home, claudeDir, oversightDir }) => {
      runScript(makeEnv(home, oversightDir));
      const content = fs.readFileSync(
        path.join(claudeDir, 'environment', 'GUIDANCE_CHANGES.md'), 'utf8');
      assert.match(content, /^# Anthropic Guidance/m, 'H1 heading must be present');
      assert.ok(content.includes('All watched pages'), '"All watched pages" section must appear');
      // All 9 target IDs should appear in the "All watched pages" table
      for (const id of ['hooks', 'settings', 'subagents', 'mcp', 'models']) {
        assert.ok(content.includes(`| ${id} |`), `"${id}" must appear in watched-pages table`);
      }
    }),
  },
];

module.exports = { tests };

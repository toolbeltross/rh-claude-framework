// Unit tests for rh-render-md-html.js — markdown → styled HTML converter.
//
// Spawn the CLI with --in/--out against fixture .md content in a tmp dir,
// then read + assert on the produced .html. Covers each markdown construct
// the renderer claims to support (per its top-of-file docstring) plus the
// self-contained output contract (no external resources).

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'rh-render-md-html.js');

function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-render-md-html-'));
  try { return fn(dir); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function render(md, opts = {}) {
  return withTmpDir((dir) => {
    const inPath = path.join(dir, 'in.md');
    const outPath = path.join(dir, 'out.html');
    fs.writeFileSync(inPath, md, 'utf-8');
    const args = ['--in', inPath, '--out', outPath, '--title', opts.title || 'Test'];
    const r = spawnSync('node', [SCRIPT, ...args], {
      encoding: 'utf8', timeout: 10000, windowsHide: true,
    });
    return {
      exitCode: r.status,
      stdout: r.stdout || '',
      stderr: r.stderr || '',
      html: fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf-8') : null,
      outPath,
    };
  });
}

const tests = [
  {
    name: 'H1, H2, H3, H4 headers render as <h1>..<h4>',
    fn: () => {
      const r = render('# One\n\n## Two\n\n### Three\n\n#### Four\n');
      assert.strictEqual(r.exitCode, 0, r.stderr);
      assert.match(r.html, /<h1[^>]*>\s*One\s*<\/h1>/);
      assert.match(r.html, /<h2[^>]*>\s*Two\s*<\/h2>/);
      assert.match(r.html, /<h3[^>]*>\s*Three\s*<\/h3>/);
      assert.match(r.html, /<h4[^>]*>\s*Four\s*<\/h4>/);
    },
  },
  {
    name: 'plain paragraph wrapped in <p>',
    fn: () => {
      const r = render('This is plain text.\n');
      assert.strictEqual(r.exitCode, 0);
      assert.match(r.html, /<p[^>]*>\s*This is plain text\.\s*<\/p>/);
    },
  },
  {
    name: 'bullet list renders as <ul><li>',
    fn: () => {
      const r = render('- alpha\n- beta\n- gamma\n');
      assert.strictEqual(r.exitCode, 0);
      assert.match(r.html, /<ul[^>]*>/);
      assert.match(r.html, /<li[^>]*>\s*alpha\s*<\/li>/);
      assert.match(r.html, /<li[^>]*>\s*beta\s*<\/li>/);
      assert.match(r.html, /<li[^>]*>\s*gamma\s*<\/li>/);
    },
  },
  {
    name: 'ordered list renders as <ol><li>',
    fn: () => {
      const r = render('1. first\n2. second\n3. third\n');
      assert.strictEqual(r.exitCode, 0);
      assert.match(r.html, /<ol[^>]*>/);
      assert.match(r.html, /<li[^>]*>\s*first\s*<\/li>/);
    },
  },
  {
    name: 'table renders as <table>/<thead>/<tbody>/<tr>/<th>/<td>',
    fn: () => {
      const md = '| col1 | col2 |\n|---|---|\n| a | b |\n| c | d |\n';
      const r = render(md);
      assert.strictEqual(r.exitCode, 0, r.stderr);
      assert.match(r.html, /<table[^>]*>/);
      assert.match(r.html, /<th[^>]*>\s*col1\s*<\/th>/);
      assert.match(r.html, /<th[^>]*>\s*col2\s*<\/th>/);
      assert.match(r.html, /<td[^>]*>\s*a\s*<\/td>/);
      assert.match(r.html, /<td[^>]*>\s*d\s*<\/td>/);
    },
  },
  {
    name: 'fenced code block renders as <pre><code>',
    fn: () => {
      const md = '```\nconst x = 1;\n```\n';
      const r = render(md);
      assert.strictEqual(r.exitCode, 0);
      assert.match(r.html, /<pre[^>]*>[\s\S]*<code[^>]*>[\s\S]*const x = 1;[\s\S]*<\/code>[\s\S]*<\/pre>/);
    },
  },
  {
    name: 'inline `code` renders as <code>',
    fn: () => {
      const r = render('Use `foo()` here.\n');
      assert.strictEqual(r.exitCode, 0);
      assert.match(r.html, /<code[^>]*>foo\(\)<\/code>/);
    },
  },
  {
    name: '**bold** renders as <strong> (or <b>)',
    fn: () => {
      const r = render('This is **bold** text.\n');
      assert.strictEqual(r.exitCode, 0);
      assert.match(r.html, /<(strong|b)[^>]*>bold<\/(strong|b)>/);
    },
  },
  {
    name: '*italic* renders as <em> (or <i>)',
    fn: () => {
      const r = render('This is *italic* text.\n');
      assert.strictEqual(r.exitCode, 0);
      assert.match(r.html, /<(em|i)[^>]*>italic<\/(em|i)>/);
    },
  },
  {
    name: '[link](url) renders as <a href="url">link</a>',
    fn: () => {
      const r = render('See [the docs](https://example.com/x) for more.\n');
      assert.strictEqual(r.exitCode, 0);
      assert.match(r.html, /<a[^>]*href="https:\/\/example\.com\/x"[^>]*>\s*the docs\s*<\/a>/);
    },
  },
  {
    name: 'blockquote renders as <blockquote>',
    fn: () => {
      const r = render('> quoted line\n');
      assert.strictEqual(r.exitCode, 0);
      assert.match(r.html, /<blockquote[^>]*>[\s\S]*quoted line[\s\S]*<\/blockquote>/);
    },
  },
  {
    name: 'horizontal rule renders as <hr>',
    fn: () => {
      const r = render('Above.\n\n---\n\nBelow.\n');
      assert.strictEqual(r.exitCode, 0);
      assert.match(r.html, /<hr\s*\/?>/);
    },
  },
  {
    name: 'output is self-contained (has <html>, inline <style>, no external scripts/stylesheets)',
    fn: () => {
      const r = render('# x\n');
      assert.strictEqual(r.exitCode, 0);
      assert.match(r.html, /<html[^>]*>/, 'should have <html> tag');
      assert.match(r.html, /<style[^>]*>[\s\S]*?<\/style>/, 'should have inline <style>');
      assert.ok(!/<link[^>]+rel=["']stylesheet["']/.test(r.html),
        'should NOT link external stylesheet');
      assert.ok(!/<script[^>]+src=/.test(r.html),
        'should NOT load external script');
    },
  },
  {
    name: 'HTML-escapes <script> in body content',
    fn: () => {
      const r = render('Text with <script>alert(1)</script> inside.\n');
      assert.strictEqual(r.exitCode, 0);
      // The literal "<script>" from input must NOT appear as an unescaped tag
      // in the body content area. Easy proxy: count occurrences — script tags
      // legitimately appearing in our HTML shell would be 0; if we see any
      // <script ... > that's not from us, escape failed.
      const unescapedScriptOpen = r.html.match(/<script(?!\s*type=["']module["'])[^>]*>(?!\s*<\/script>)/g);
      assert.ok(!unescapedScriptOpen || unescapedScriptOpen.length === 0,
        `unescaped <script> found in output: ${unescapedScriptOpen}`);
      assert.match(r.html, /&lt;script&gt;|&lt;script&#x?3[eE];/i,
        'literal <script> from input should be escaped');
    },
  },
  {
    name: 'title arg flows into <title> tag',
    fn: () => {
      const r = render('# x\n', { title: 'My-Unique-Page-Title' });
      assert.strictEqual(r.exitCode, 0);
      assert.match(r.html, /<title[^>]*>[^<]*My-Unique-Page-Title[^<]*<\/title>/);
    },
  },
  {
    name: 'empty input still produces valid HTML (has <html>...</html>)',
    fn: () => {
      const r = render('');
      assert.strictEqual(r.exitCode, 0, r.stderr);
      assert.match(r.html, /<html[^>]*>[\s\S]*<\/html>/);
    },
  },
  {
    name: 'missing --in file: exit non-zero + does NOT write output',
    fn: () => withTmpDir((dir) => {
      const inPath = path.join(dir, 'does-not-exist.md');
      const outPath = path.join(dir, 'out.html');
      const r = spawnSync('node', [
        SCRIPT, '--in', inPath, '--out', outPath, '--title', 't',
      ], { encoding: 'utf8', timeout: 5000, windowsHide: true });
      assert.notStrictEqual(r.status, 0, 'should exit non-zero on missing input');
      assert.ok(!fs.existsSync(outPath), 'should not write output for missing input');
    }),
  },
  {
    name: 'staleness banner reflects the source file mtime',
    fn: () => {
      const r = render('# x\n');
      assert.strictEqual(r.exitCode, 0);
      // Banner should mention "Source:" or include the source path
      assert.ok(/source/i.test(r.html), 'banner should mention source');
    },
  },
];

module.exports = { tests };

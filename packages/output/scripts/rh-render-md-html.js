#!/usr/bin/env node
/**
 * render-md-html.js
 *
 * Minimal markdown → styled HTML converter.
 * Produces a self-contained HTML file with inline dark-theme CSS matching the
 * aesthetic of the existing ENVIRONMENT.html / OVERSIGHT_SYSTEM.html dashboards.
 *
 * Supports: H1–H4, tables, bullet lists, ordered lists, blockquotes,
 * fenced code blocks (``` ... ```), inline `code`, **bold**, *italic*, [link](url),
 * horizontal rules, and plain paragraphs. No npm dependencies — Node stdlib only.
 *
 * Usage:
 *   node render-md-html.js --in <path.md> --out <path.html> --title "<title>"
 *
 * Exit codes: 0 success, 1 error.
 */

const fs = require("fs");
const path = require("path");
const { withLock } = require("./lib/file-lock");

// ───────────────────────── Arg parsing ─────────────────────────

function parseArgs(argv) {
  const args = { in: null, out: null, title: "Dashboard", skipIfUnchanged: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--in" && argv[i + 1]) { args.in = argv[++i]; }
    else if (a === "--out" && argv[i + 1]) { args.out = argv[++i]; }
    else if (a === "--title" && argv[i + 1]) { args.title = argv[++i]; }
    else if (a === "--skip-if-unchanged") { args.skipIfUnchanged = true; }
  }
  return args;
}

// ───────────────────────── HTML escape ─────────────────────────

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ───────────────────────── Staleness banner ─────────────────────────
// Reads the source file's mtime and renders a human-readable "last updated"
// status at the top of the page. Color-coded by age so a glance at the
// rendered HTML tells the user whether the pipeline is current or has stalled.

function humanTime(date) {
  const datePart = date.toLocaleDateString("sv-SE");
  const timePart = date.toLocaleTimeString("en-GB", { hour12: false });
  const tzShort = date.toLocaleTimeString("en-US", { timeZoneName: "short" }).split(" ").pop();
  return `${datePart} ${timePart} ${tzShort}`;
}

function humanAge(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} seconds ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

function stalenessBanner(sourcePath) {
  try {
    const stat = fs.statSync(sourcePath);
    const mtime = stat.mtime;
    const ageMs = Date.now() - mtime.getTime();
    const ageH = ageMs / (1000 * 60 * 60);
    let className, label;
    if (ageH < 36) { className = "fresh"; label = "FRESH"; }
    else if (ageH < 24 * 7) { className = "stale"; label = "STALE"; }
    else { className = "very-stale"; label = "VERY STALE"; }
    const human = humanTime(mtime);
    const ago = humanAge(ageMs);
    return `<div class="status-banner ${className}">
  <span class="status-label">${label}</span>
  <span class="status-text">⏱ Source last updated <strong>${esc(human)}</strong> (${esc(ago)})</span>
  <span class="status-source">${esc(path.basename(sourcePath))}</span>
</div>`;
  } catch {
    return `<div class="status-banner very-stale"><span class="status-label">UNKNOWN</span><span class="status-text">Could not read source mtime</span></div>`;
  }
}

// ───────────────────────── Inline parser ─────────────────────────
// Handles: `code`, **bold**, *italic*, [text](url). Escapes HTML first,
// then re-injects the formatting tags. Order matters: code first to avoid
// interfering with other markers inside code spans.

function inline(text) {
  const codeSpans = [];
  let t = text.replace(/`([^`]+)`/g, (_, code) => {
    codeSpans.push(code);
    return `\x00C${codeSpans.length - 1}\x00`;
  });
  t = esc(t);
  t = t.replace(/\x00C(\d+)\x00/g, (_, i) => `<code>${esc(codeSpans[Number(i)])}</code>`);
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|\s)\*([^*\s][^*]*[^*\s])\*(?=\s|$|[.,;:!?])/g, "$1<em>$2</em>");
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
    const safeHref = href.replace(/"/g, "&quot;");
    return `<a href="${safeHref}">${label}</a>`;
  });
  return t;
}

// ───────────────────────── Block parser ─────────────────────────

function parseMarkdown(md) {
  const lines = md.split(/\r?\n/);
  const out = [];
  let i = 0;

  const flushParagraph = (buf) => {
    if (buf.length > 0) {
      out.push(`<p>${inline(buf.join(" "))}</p>`);
      buf.length = 0;
    }
  };

  let paragraph = [];

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (/^```/.test(line)) {
      flushParagraph(paragraph);
      const lang = line.replace(/^```/, "").trim();
      const codeLines = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      const langAttr = lang ? ` class="lang-${esc(lang)}"` : "";
      out.push(`<pre><code${langAttr}>${esc(codeLines.join("\n"))}</code></pre>`);
      continue;
    }

    // Horizontal rule
    if (/^---+\s*$/.test(line) && paragraph.length === 0) {
      out.push("<hr/>");
      i++;
      continue;
    }

    // Headings
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushParagraph(paragraph);
      const level = h[1].length;
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      flushParagraph(paragraph);
      const quoteLines = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${inline(quoteLines.join(" "))}</blockquote>`);
      continue;
    }

    // Table: header row followed by separator row
    if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|[\s\-:|]+\|\s*$/.test(lines[i + 1])) {
      flushParagraph(paragraph);
      const header = line.replace(/^\||\|$/g, "").split("|").map(c => c.trim());
      i += 2; // skip header + separator
      const rows = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) {
        const cells = lines[i].replace(/^\||\|$/g, "").split("|").map(c => c.trim());
        rows.push(cells);
        i++;
      }
      const thead = "<thead><tr>" + header.map(c => `<th>${inline(c)}</th>`).join("") + "</tr></thead>";
      const tbody = "<tbody>" + rows.map(r => "<tr>" + r.map(c => `<td>${inline(c)}</td>`).join("") + "</tr>").join("") + "</tbody>";
      out.push(`<table>${thead}${tbody}</table>`);
      continue;
    }

    // Unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      flushParagraph(paragraph);
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      out.push("<ul>" + items.map(it => `<li>${inline(it)}</li>`).join("") + "</ul>");
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      flushParagraph(paragraph);
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      out.push("<ol>" + items.map(it => `<li>${inline(it)}</li>`).join("") + "</ol>");
      continue;
    }

    // Blank line = paragraph break
    if (line.trim() === "") {
      flushParagraph(paragraph);
      i++;
      continue;
    }

    // Default: accumulate into current paragraph
    paragraph.push(line);
    i++;
  }
  flushParagraph(paragraph);
  return out.join("\n");
}

// ───────────────────────── HTML shell + CSS ─────────────────────────

function htmlShell(title, bodyHtml, sourcePath, banner) {
  const now = new Date().toISOString();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'SF Mono', 'Cascadia Code', 'Consolas', 'Fira Code', monospace;
    background: #0d1117;
    color: #c9d1d9;
    font-size: 13px;
    line-height: 1.6;
    padding: 0;
  }
  .page { max-width: 1200px; margin: 0 auto; padding: 32px 24px; }

  h1 { font-size: 22px; color: #f0f6fc; font-weight: 700; letter-spacing: -0.5px; margin-bottom: 4px; }
  h2 {
    font-size: 13px;
    color: #58a6ff;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1.5px;
    margin: 32px 0 12px;
    padding-bottom: 6px;
    border-bottom: 1px solid #21262d;
  }
  h3 { font-size: 13px; color: #e6edf3; font-weight: 700; margin: 20px 0 8px; }
  h4 { font-size: 11px; color: #8b949e; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px; margin: 14px 0 6px; }

  p { color: #8b949e; margin: 8px 0; }
  a { color: #58a6ff; text-decoration: none; }
  a:hover { text-decoration: underline; }

  strong { color: #e6edf3; font-weight: 700; }
  em { color: #d2a8ff; font-style: italic; }

  code {
    background: #161b22;
    color: #e3a847;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 12px;
    border: 1px solid #21262d;
  }

  pre {
    background: #161b22;
    border: 1px solid #21262d;
    border-radius: 6px;
    padding: 14px 16px;
    overflow-x: auto;
    margin: 12px 0;
  }
  pre code {
    background: none;
    border: none;
    padding: 0;
    color: #c9d1d9;
    font-size: 12px;
  }

  blockquote {
    border-left: 3px solid #58a6ff;
    background: #161b22;
    padding: 10px 14px;
    margin: 12px 0;
    color: #8b949e;
    border-radius: 0 4px 4px 0;
  }

  hr {
    border: 0;
    border-top: 1px solid #21262d;
    margin: 24px 0;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    margin: 12px 0;
    font-size: 12px;
  }
  thead tr { background: #161b22; }
  thead th {
    text-align: left;
    padding: 8px 12px;
    color: #8b949e;
    font-weight: 700;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    border-bottom: 1px solid #21262d;
    white-space: nowrap;
  }
  tbody td {
    padding: 7px 12px;
    border-bottom: 1px solid #161b22;
    color: #c9d1d9;
    vertical-align: top;
  }
  tbody tr:hover { background: #161b22; }

  ul, ol { margin: 8px 0 12px 24px; color: #c9d1d9; }
  li { padding: 2px 0; }

  .meta-footer {
    margin-top: 48px;
    padding-top: 16px;
    border-top: 1px solid #21262d;
    color: #6e7681;
    font-size: 11px;
  }

  .status-banner {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 14px 18px;
    margin-bottom: 24px;
    border-radius: 8px;
    font-size: 13px;
    border: 2px solid;
  }
  .status-banner .status-label {
    font-weight: 800;
    font-size: 11px;
    letter-spacing: 1px;
    padding: 4px 10px;
    border-radius: 4px;
    white-space: nowrap;
  }
  .status-banner .status-text { flex: 1; color: #e6edf3; }
  .status-banner .status-text strong { color: #f0f6fc; }
  .status-banner .status-source {
    font-size: 11px;
    color: #8b949e;
    font-family: 'SF Mono', monospace;
  }
  .status-banner.fresh { border-color: #3fb950; background: #0f1d12; }
  .status-banner.fresh .status-label { background: #3fb950; color: #0d1117; }
  .status-banner.stale { border-color: #d29922; background: #1c180a; }
  .status-banner.stale .status-label { background: #d29922; color: #0d1117; }
  .status-banner.very-stale { border-color: #f85149; background: #1d0f0f; }
  .status-banner.very-stale .status-label { background: #f85149; color: #0d1117; }
</style>
</head>
<body>
<div class="page">
${banner || ""}
${bodyHtml}
<div class="meta-footer">
  Rendered by <code>render-md-html.js</code> at ${esc(now)}${sourcePath ? ` from <code>${esc(sourcePath)}</code>` : ""}.
</div>
</div>
</body>
</html>
`;
}

// ───────────────────────── Main ─────────────────────────

function main() {
  const args = parseArgs(process.argv);
  if (!args.in || !args.out) {
    console.error("Usage: node render-md-html.js --in <path.md> --out <path.html> --title \"<title>\" [--skip-if-unchanged]");
    process.exit(1);
  }
  if (!fs.existsSync(args.in)) {
    console.error(`[render-md-html] Input file not found: ${args.in}`);
    process.exit(1);
  }
  // Skip-if-unchanged: if output exists and is at least as new as the input, do nothing.
  if (args.skipIfUnchanged && fs.existsSync(args.out)) {
    const inStat = fs.statSync(args.in);
    const outStat = fs.statSync(args.out);
    if (outStat.mtimeMs >= inStat.mtimeMs) {
      console.log(`[render-md-html] Skipped ${args.out} (source unchanged since last render)`);
      return;
    }
  }
  const md = fs.readFileSync(args.in, "utf8");
  const bodyHtml = parseMarkdown(md);
  const banner = stalenessBanner(args.in);
  const html = htmlShell(args.title, bodyHtml, args.in.replace(/\\/g, "/"), banner);
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  // Cross-process lock — daily-regen renders 3 HTMLs back-to-back, but two
  // sessions could trigger overlapping daily-regens (SessionStart hook).
  withLock(args.out, () => {
    fs.writeFileSync(args.out, html, "utf8");
  });
  console.log(`[render-md-html] Wrote ${args.out} (${html.length} bytes) from ${args.in}`);
}

try {
  main();
  process.exit(0);
} catch (e) {
  console.error(`[render-md-html] FAILED: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
}

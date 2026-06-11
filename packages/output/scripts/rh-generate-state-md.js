#!/usr/bin/env node
/**
 * generate-state-md.js
 *
 * Scans the filesystem for oversight-relevant state and writes a live markdown
 * snapshot to OVERSIGHT_STATE.md inside the configured oversight directory.
 *
 * Purpose: This file is the "current state" companion to OVERSIGHT_SYSTEM.md
 * (the hand-authored design doc). The design doc contains 8 failure modes (F-01..F-08)
 * identified during the 2026-04-04 consolidation incident; this state file tracks which
 * rules/hooks/agents are in place today to mitigate each one.
 *
 * Stateless, idempotent, no npm deps. Called by daily-regen.js or run standalone.
 *
 * Usage: node generate-state-md.js
 */

const fs = require("fs");
const path = require("path");
const { config } = require("./lib/config");
const { withLock } = require("./lib/file-lock");

const CLAUDE_DIR = config.claudeDir;
const OUTPUT_PATH = path.join(config.oversightDir, "OVERSIGHT_STATE.md");
const SUPERVISORY_LOG = path.join(config.oversightDir, "supervisory-log.md");
const LAYER3_PLAN = config.planFile || null;
const DESIGN_DOC = path.join(config.oversightDir, "OVERSIGHT_SYSTEM.md");

// ───────────────────────── Failure → mitigation mapping (parsed from design doc) ─────────────────────────
// As of 2026-04-25, the canonical FAILURES data lives inside OVERSIGHT_SYSTEM.md
// in a `<!-- failures-data:begin -->` / `<!-- failures-data:end -->` block.
// This means new failure modes (F-09 etc.) are added by editing the design doc
// only — the generator picks them up automatically. A cross-check below warns
// if the human Failure Analysis table and the JSON data block fall out of sync.

function loadFailuresFromDesignDoc() {
  // Fail-soft on missing design doc: sectionHeader() already reports
  // "NOT FOUND" in the generated output. Crashing here at module-load time
  // would prevent the rest of the state doc (rules / hooks / agents / log)
  // from being generated at all — making the absence harder to recover from.
  // Empty failure set is correct when the design doc isn't present yet.
  let designDocText;
  try {
    designDocText = fs.readFileSync(DESIGN_DOC, "utf8");
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.warn(`[generate-state-md] WARN: OVERSIGHT_SYSTEM.md not found at ${DESIGN_DOC} — failure-mitigation section will be empty.`);
      return [];
    }
    throw e;
  }

  // Extract the JSON block between the begin/end HTML comment markers.
  const blockMatch = designDocText.match(
    /<!--\s*failures-data:begin\s*-->([\s\S]*?)<!--\s*failures-data:end\s*-->/
  );
  if (!blockMatch) {
    throw new Error(
      `[generate-state-md] failures-data block not found in OVERSIGHT_SYSTEM.md.\n` +
      `Expected markers: <!-- failures-data:begin --> ... <!-- failures-data:end -->\n` +
      `Path: ${DESIGN_DOC}`
    );
  }
  // Strip the ```json fence inside the block, parse the inner JSON.
  const inner = blockMatch[1]
    .replace(/^\s*```json\s*\n/, "")
    .replace(/\n\s*```\s*$/, "")
    .trim();
  let data;
  try {
    data = JSON.parse(inner);
  } catch (e) {
    throw new Error(
      `[generate-state-md] failures-data JSON parse error in OVERSIGHT_SYSTEM.md: ${e.message}`
    );
  }
  if (!Array.isArray(data)) {
    throw new Error(`[generate-state-md] failures-data must be a JSON array.`);
  }

  // Cross-check: every F-NN in the human Failure Analysis table should also
  // appear in the JSON data, and vice versa. Warn loudly if not.
  const proseTableMatch = designDocText.match(/## Failure Analysis[\s\S]*?(?=\n##\s)/);
  if (proseTableMatch) {
    const proseIds = new Set();
    const idRe = /\|\s*\*\*F-(\d{2})\*\*\s*\|/g;
    let im;
    while ((im = idRe.exec(proseTableMatch[0])) !== null) proseIds.add(`F-${im[1]}`);
    const dataIds = new Set(data.map(f => f.id));
    const missingFromData = [...proseIds].filter(id => !dataIds.has(id));
    const missingFromProse = [...dataIds].filter(id => !proseIds.has(id));
    if (missingFromData.length || missingFromProse.length) {
      console.warn(`[generate-state-md] WARN: failure-mode IDs out of sync between prose table and JSON data block.`);
      if (missingFromData.length) console.warn(`  In prose table but missing from JSON: ${missingFromData.join(", ")}`);
      if (missingFromProse.length) console.warn(`  In JSON but missing from prose table: ${missingFromProse.join(", ")}`);
    }
  }

  // Validation: fail-fast on malformed entries instead of silently rendering
  // them as "✅ FULLY MITIGATED" (which is what an empty mitigations array
  // produces because [].every(...) is vacuously true) or crashing later in
  // expand() on a missing path key.
  for (const F of data) {
    if (!F || typeof F.id !== "string") {
      throw new Error(`[generate-state-md] failure entry missing id: ${JSON.stringify(F)}`);
    }
    if (!Array.isArray(F.mitigations) || F.mitigations.length === 0) {
      throw new Error(`[generate-state-md] ${F.id} has no mitigations — half-finished entry?`);
    }
    for (const m of F.mitigations) {
      if (!m || !m.type || !m.file || !m.path) {
        throw new Error(`[generate-state-md] ${F.id} has malformed mitigation: ${JSON.stringify(m)}`);
      }
    }
  }
  return data;
}

const FAILURES = loadFailuresFromDesignDoc();

const OVERSIGHT_AGENT_NAMES = ["supervisor", "source-verifier", "facilitator", "docs-knowledge"];

// ───────────────────────── Helpers ─────────────────────────

function fileExists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function expand(p) {
  if (p.startsWith("~/")) return path.join(config.home, p.slice(2));
  if (p.startsWith(".claude/")) return path.join(config.workspace, p);
  return p;
}

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function readFirstLine(p) {
  try {
    const content = fs.readFileSync(p, "utf8");
    // Strip YAML frontmatter block if present, then return first non-empty line.
    const fm = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
    const body = fm ? content.slice(fm[0].length) : content;
    for (const line of body.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) return trimmed;
    }
    return "(empty)";
  } catch { return "(unreadable)"; }
}

function listFiles(dir, ext) {
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith(ext))
      .map(f => path.join(dir, f))
      .sort();
  } catch { return []; }
}

function extractFrontmatter(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return {};
    const fm = {};
    for (const line of match[1].split(/\r?\n/)) {
      const idx = line.indexOf(":");
      if (idx > 0) {
        const key = line.slice(0, idx).trim();
        const val = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
        fm[key] = val;
      }
    }
    return fm;
  } catch { return {}; }
}

function mdEscape(s) {
  return String(s || "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function tail(filePath, n) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split(/\r?\n/);
    return lines.slice(-n);
  } catch { return []; }
}

function humanTime() {
  const d = new Date();
  const datePart = d.toLocaleDateString("sv-SE");
  const timePart = d.toLocaleTimeString("en-GB", { hour12: false });
  const tzShort = d.toLocaleTimeString("en-US", { timeZoneName: "short" }).split(" ").pop();
  return `${datePart} ${timePart} ${tzShort}`;
}

// ───────────────────────── Sections ─────────────────────────

function sectionHeader() {
  const designExists = fileExists(DESIGN_DOC);
  const local = humanTime();
  const iso = new Date().toISOString();
  return [
    "# Oversight System — Current State",
    "",
    `## ⏱ Last updated: **${local}**`,
    "",
    "> **Auto-generated.** Do not edit by hand — rewrite via `node ~/.claude/scripts/rh-generate-state-md.js`.",
    "> Run daily at 06:00 local by Windows Task Scheduler (`Claude Code Daily Regen`). This file is the live companion to the authored design doc.",
    "> **If the timestamp above is more than ~24 hours old, the scheduled task likely failed — check `~/.claude/scripts/daily-regen.log`.**",
    "",
    `**Authoritative design doc:** [\`OVERSIGHT_SYSTEM.md\`](./OVERSIGHT_SYSTEM.md)${designExists ? "" : " ⚠ NOT FOUND"}`,
    `**Generated (local):** \`${local}\``,
    `**Generated (UTC):** \`${iso}\``,
    "",
    "---",
    "",
  ].join("\n");
}

function sectionRulesInPlace() {
  const lines = ["## Rules In Place", ""];
  const rulesDir = config.rulesDir;
  const files = listFiles(rulesDir, ".md");
  lines.push(`Source: \`${rulesDir.replace(/\\/g, "/")}\` — ${files.length} rule${files.length === 1 ? "" : "s"}`);
  lines.push("");
  lines.push("| Rule File | H1 | Closes Failure(s) |");
  lines.push("|---|---|---|");
  for (const f of files) {
    const name = path.basename(f);
    const firstLine = readFirstLine(f).replace(/^#\s*/, "");
    const closes = FAILURES
      .filter(F => F.mitigations.some(m => m.type === "rule" && m.file === name))
      .map(F => F.id)
      .join(", ") || "—";
    lines.push(`| \`${name}\` | ${mdEscape(firstLine).slice(0, 80)} | ${closes} |`);
  }
  lines.push("");
  return lines.join("\n");
}

function sectionHooksActive() {
  const lines = ["## Hooks Active", ""];
  const settings = readJSON(config.settingsPath);
  if (!settings || !settings.hooks) {
    lines.push("> No hooks in `~/.claude/settings.json`");
    lines.push("");
    return lines.join("\n");
  }
  // Collect all hook rows, then group by script name for compact presentation.
  const rows = [];
  for (const [phase, matchers] of Object.entries(settings.hooks)) {
    for (const matcher of matchers) {
      const target = matcher.matcher || "*";
      for (const h of (matcher.hooks || [])) {
        const cmd = h.command || "";
        if (!cmd && (h.type === "prompt" || h.prompt)) {
          // Prompt-type hooks have no command; an empty cell here previously
          // read as a malformed entry (OI-23 false positive, 2026-06-11).
          rows.push({ phase, target, script: "(prompt) " + mdEscape((h.prompt || "").slice(0, 48)) + "…" });
          continue;
        }
        const scriptMatch = cmd.match(/([^/\\"]+\.js)/);
        const script = scriptMatch ? scriptMatch[1] : mdEscape(cmd.slice(0, 40));
        rows.push({ phase, target, script });
      }
    }
  }
  // Classify scripts: oversight-critical stay individual; known telemetry always grouped.
  const OVERSIGHT_CRITICAL = /consolidation-guard|agent-oversight-guard|tool-validator|read-audit/;
  const TELEMETRY = /hook-forwarder|start-bg/;
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.script)) groups.set(row.script, []);
    groups.get(row.script).push(row);
  }
  const oversightRows = [];
  const groupedRows = [];
  for (const [script, scriptRows] of groups) {
    if (OVERSIGHT_CRITICAL.test(script)) {
      for (const r of scriptRows) oversightRows.push(r);
    } else if (TELEMETRY.test(script)) {
      const events = scriptRows.map(r => r.phase).join(", ");
      groupedRows.push({ script, count: scriptRows.length, events });
    } else {
      // Unknown script — default to individual rows (don't hide it)
      for (const r of scriptRows) oversightRows.push(r);
    }
  }
  lines.push("### Oversight-enforcing hooks", "");
  lines.push("| Phase | Matcher | Script | Closes Failure(s) |");
  lines.push("|---|---|---|---|");
  for (const r of oversightRows) {
    const closes = FAILURES
      .filter(F => F.mitigations.some(m => m.type === "hook" && r.script.includes(m.file)))
      .map(F => F.id)
      .join(", ") || "—";
    lines.push(`| \`${r.phase}\` | \`${r.target}\` | \`${r.script}\` | ${closes} |`);
  }
  lines.push("");
  if (groupedRows.length > 0) {
    lines.push("### Telemetry & forwarder hooks (grouped — not oversight-critical)", "");
    lines.push("| Script | Event Count | Events |");
    lines.push("|---|---|---|");
    for (const g of groupedRows) {
      lines.push(`| \`${g.script}\` | ${g.count} | ${mdEscape(g.events).slice(0, 100)} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function sectionOversightAgents() {
  const lines = ["## Oversight-Related Agents", ""];
  const agentsDir = config.agentsDir;
  const matched = [];
  for (const f of listFiles(agentsDir, ".md")) {
    const fm = extractFrontmatter(f);
    const name = fm.name || path.basename(f, ".md");
    if (OVERSIGHT_AGENT_NAMES.includes(name.replace(/^rh-/, ''))) {
      matched.push({
        name,
        model: fm.model || "(default)",
        description: fm.description || "",
        file: path.basename(f),
      });
    }
  }
  if (matched.length === 0) {
    lines.push("> None of the expected oversight agents (supervisor, source-verifier, facilitator, docs-knowledge) found");
    lines.push("");
    return lines.join("\n");
  }
  lines.push("| Agent | Model | Closes | Description |");
  lines.push("|---|---|---|---|");
  for (const a of matched) {
    const closes = FAILURES
      .filter(F => F.mitigations.some(m => m.type === "agent" && m.file === a.file))
      .map(F => F.id)
      .join(", ") || "—";
    lines.push(`| \`${a.name}\` | \`${a.model}\` | ${closes} | ${mdEscape(a.description).slice(0, 100)} |`);
  }
  lines.push("");
  // Note: matched agents store the file's frontmatter `name`, which today is
  // always rh-prefixed (e.g. `rh-supervisor`); OVERSIGHT_AGENT_NAMES is the
  // unprefixed list (e.g. `supervisor`). Strip prefix on both sides before
  // comparing so present agents aren't falsely reported missing. Tolerates a
  // future revert to unprefixed naming.
  const missing = OVERSIGHT_AGENT_NAMES.filter(n => !matched.find(m => m.name.replace(/^rh-/, '') === n));
  if (missing.length > 0) {
    lines.push(`⚠ **Missing:** ${missing.map(n => "`" + n + "`").join(", ")}`);
    lines.push("");
  }
  return lines.join("\n");
}

function sectionFailureMitigation() {
  const lines = [
    "## Failure Mode Mitigation Status",
    "",
    "For each of the 8 failure modes identified in OVERSIGHT_SYSTEM.md, the table shows which proposed mitigations are verified present on disk today.",
    "",
  ];
  for (const F of FAILURES) {
    const present = F.mitigations.filter(m => fileExists(expand(m.path)));
    const missing = F.mitigations.filter(m => !fileExists(expand(m.path)));
    const status = missing.length === 0 ? "✅ FULLY MITIGATED" : present.length === 0 ? "❌ NOT MITIGATED" : "⚠ PARTIAL";
    lines.push(`### ${F.id} · ${F.title} — ${status}`);
    lines.push("");
    lines.push(`${F.summary}`);
    lines.push("");
    lines.push("| Mitigation | Type | Status |");
    lines.push("|---|---|---|");
    for (const m of F.mitigations) {
      const exists = fileExists(expand(m.path));
      lines.push(`| \`${m.file}\` | ${m.type} | ${exists ? "✓ present" : "✗ missing"} |`);
    }
    lines.push("");
  }
  const fully = FAILURES.filter(F => F.mitigations.every(m => fileExists(expand(m.path)))).length;
  const partial = FAILURES.filter(F => {
    const p = F.mitigations.filter(m => fileExists(expand(m.path))).length;
    return p > 0 && p < F.mitigations.length;
  }).length;
  const none = FAILURES.filter(F => F.mitigations.every(m => !fileExists(expand(m.path)))).length;
  lines.push(`**Summary:** ${fully} fully mitigated · ${partial} partial · ${none} not mitigated (of ${FAILURES.length} failure modes)`);
  lines.push("");
  return lines.join("\n");
}

/**
 * F-05: parse the most recent ISO-style timestamp out of the log tail and
 * compute hours-since. Supervisory-log entries have the form
 *   - **2026-04-24 06:24:21** | `b7dba87d` | Turn 19 | ...
 * so we look for "YYYY-MM-DD HH:MM:SS" anywhere in the tail and pick the max.
 */
function parseSupervisoryLogStaleness(tailLines) {
  const tsRegex = /\b(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\b/g;
  let latestMs = 0;
  for (const line of tailLines) {
    let m;
    while ((m = tsRegex.exec(line)) !== null) {
      const iso = `${m[1]}T${m[2]}Z`;
      const ms = Date.parse(iso);
      if (!isNaN(ms) && ms > latestMs) latestMs = ms;
    }
  }
  if (!latestMs) return null;
  const hoursOld = (Date.now() - latestMs) / (1000 * 60 * 60);
  return { latestMs, hoursOld, latestIso: new Date(latestMs).toISOString() };
}

function sectionSupervisoryLog() {
  const lines = ["## Supervisory Log — Recent Entries", ""];
  if (!fileExists(SUPERVISORY_LOG)) {
    lines.push(`> Log not found at \`${SUPERVISORY_LOG.replace(/\\/g, "/")}\``);
    lines.push("");
    return lines.join("\n");
  }
  const allLines = tail(SUPERVISORY_LOG, 40);

  // F-05 staleness banner: surface drift before it becomes another 9-day incident
  // (precedent: 2026-04-15 supervisory-log drift). Thresholds chosen for human
  // attention: > 72h is loud, > 48h is a heads-up, > 24h is informational.
  const staleness = parseSupervisoryLogStaleness(allLines);
  if (staleness) {
    const h = staleness.hoursOld;
    const lastHuman = staleness.latestIso.replace("T", " ").replace(/\.\d+Z$/, "Z");
    if (h > 72) {
      lines.push(`> ⚠️ **STALE LOG — last entry ${h.toFixed(1)}h ago (${lastHuman}).** The telemetry writer (\`hook-forwarder.js\`) may be broken. See \`incidents/2026-04-15-supervisory-log-drift.md\` for the prior precedent.`);
      lines.push("");
    } else if (h > 48) {
      lines.push(`> ⚠ Log drift: last entry ${h.toFixed(1)}h ago (${lastHuman}). Approaching the 72h drift threshold — verify \`hook-forwarder.js\` is firing on Stop hooks.`);
      lines.push("");
    } else if (h > 24) {
      lines.push(`> ℹ Log last updated ${h.toFixed(1)}h ago (${lastHuman}).`);
      lines.push("");
    }
  } else {
    lines.push(`> ⚠ Could not parse a timestamp from the log tail — staleness check skipped.`);
    lines.push("");
  }

  lines.push("Last 40 lines of `supervisory-log.md`:");
  lines.push("");
  lines.push("```");
  for (const l of allLines) {
    lines.push(l);
  }
  lines.push("```");
  lines.push("");
  lines.push(`Full log: \`${SUPERVISORY_LOG.replace(/\\/g, "/")}\``);
  lines.push("");
  return lines.join("\n");
}

function sectionLayer3Status() {
  const lines = ["## Oversight System — Current Plan", ""];
  if (!LAYER3_PLAN) {
    lines.push("> No plan file configured (`config.planFile` not set). Skipping plan section.");
    lines.push("");
    return lines.join("\n");
  }
  if (!fileExists(LAYER3_PLAN)) {
    lines.push(`> Plan doc not found at \`${LAYER3_PLAN.replace(/\\/g, "/")}\``);
    lines.push("");
    return lines.join("\n");
  }
  const content = fs.readFileSync(LAYER3_PLAN, "utf8");
  const firstLines = content.split(/\r?\n/).slice(0, 20);
  const planBasename = path.basename(LAYER3_PLAN);
  lines.push(`First 20 lines of \`${planBasename}\`:`);
  lines.push("");
  lines.push("```");
  for (const l of firstLines) lines.push(l);
  lines.push("```");
  lines.push("");
  lines.push(`Full plan: \`${LAYER3_PLAN.replace(/\\/g, "/")}\``);
  lines.push("");
  return lines.join("\n");
}

function sectionFooter() {
  const planLink = LAYER3_PLAN
    ? ` · [\`${path.basename(LAYER3_PLAN)}\`](${path.relative(config.oversightDir, LAYER3_PLAN).replace(/\\/g, "/")})`
    : "";
  return [
    "---",
    "",
    `Generated \`${new Date().toISOString()}\` · Rebuild manually: \`node ~/.claude/scripts/rh-generate-state-md.js\``,
    "",
    `See also: [\`OVERSIGHT_SYSTEM.md\`](./OVERSIGHT_SYSTEM.md) · [\`supervisory-log.md\`](./supervisory-log.md)${planLink}`,
    "",
  ].join("\n");
}

// ───────────────────────── Main ─────────────────────────

function main() {
  const sections = [
    sectionHeader(),
    sectionFailureMitigation(),
    sectionRulesInPlace(),
    sectionHooksActive(),
    sectionOversightAgents(),
    sectionSupervisoryLog(),
    sectionLayer3Status(),
    sectionFooter(),
  ];
  const output = sections.join("\n");
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  // Cross-process lock — concurrent sessions may both trigger daily-regen → state-md.
  withLock(OUTPUT_PATH, () => {
    fs.writeFileSync(OUTPUT_PATH, output, "utf8");
  });
  console.log(`[generate-state-md] Wrote ${OUTPUT_PATH} (${output.length} bytes)`);
}

try {
  main();
  process.exit(0);
} catch (e) {
  console.error(`[generate-state-md] FAILED: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
}

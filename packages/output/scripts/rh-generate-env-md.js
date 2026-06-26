#!/usr/bin/env node
/**
 * generate-env-md.js
 *
 * Scans the filesystem (agents, hooks, rules, skills, memories, plans, MCP config)
 * and writes a live markdown inventory to:
 *   <oversightDir>/../environment/ENVIRONMENT.md
 *
 * Stateless, idempotent, no npm deps (beyond ./lib/config). Called by daily-regen.js or run standalone.
 *
 * Usage: node rh-generate-env-md.js
 *
 * Helpers copied from ~/.claude/skills/rh-session/scripts/session-inventory.js
 * (kept inline to decouple this script from the /session skill).
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const { config } = require("./lib/config");

const OUTPUT_PATH = path.join(config.oversightDir, "..", "environment", "ENVIRONMENT.md");
const MCP_CONFIG_PATH = path.join(config.home, "AppData", "Roaming", "Claude", "claude_desktop_config.json");
const MCP_EXTENSIONS_PATH = path.join(config.home, "AppData", "Roaming", "Claude", "extensions-installations.json");
const CLAUDE_USER_CONFIG_PATH = path.join(config.home, ".claude.json");  // Claude Code stdio MCP servers live here

// ───────────────────────── Helpers ─────────────────────────

function fileExists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
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

function fileSize(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}

function humanTime() {
  // Returns e.g. "2026-04-15 08:52:04 PDT" — human-scannable for staleness detection.
  const d = new Date();
  const datePart = d.toLocaleDateString("sv-SE"); // "2026-04-15"
  const timePart = d.toLocaleTimeString("en-GB", { hour12: false }); // "08:52:04"
  const tzShort = d.toLocaleTimeString("en-US", { timeZoneName: "short" }).split(" ").pop();
  return `${datePart} ${timePart} ${tzShort}`;
}

// ───────────────────────── Section: Header ─────────────────────────

function sectionHeader() {
  const local = humanTime();
  const iso = new Date().toISOString();
  const osVer = `${os.type()} ${os.release()}`;
  const nodeVer = process.version;
  return [
    "# Environment Inventory",
    "",
    `## ⏱ Last updated: **${local}**`,
    "",
    "> **Auto-generated.** Do not edit by hand — rewrite this file via `node ~/.claude/scripts/rh-generate-env-md.js`.",
    "> Run daily at 06:00 local by Windows Task Scheduler (`Claude Code Daily Regen`).",
    "> **If the timestamp above is more than ~24 hours old, the scheduled task likely failed — check `~/.claude/scripts/daily-regen.log`.**",
    "",
    "| Field | Value |",
    "|---|---|",
    `| Generated (local) | \`${local}\` |`,
    `| Generated (UTC) | \`${iso}\` |`,
    `| User | \`${os.userInfo().username}\` |`,
    `| OS | \`${osVer}\` |`,
    `| Node | \`${nodeVer}\` |`,
    `| Home | \`${config.home.replace(/\\/g, "/")}\` |`,
    `| Workspace | \`${config.workspace}\` |`,
    "",
  ].join("\n");
}

// ───────────────────────── Section: MCP Servers ─────────────────────────

function sectionMcpServers() {
  const lines = ["## MCP Servers", ""];
  // Source 1: Claude Desktop user-configured MCPs in claude_desktop_config.json
  const cfg = readJSON(MCP_CONFIG_PATH);
  const configServers = [];
  if (cfg && cfg.mcpServers) {
    for (const name of Object.keys(cfg.mcpServers).sort()) {
      const s = cfg.mcpServers[name];
      configServers.push({
        name,
        source: "Desktop config",
        command: s.command || "(inherited)",
        args: Array.isArray(s.args) ? s.args.slice(0, 2).join(" ") : "",
      });
    }
  }
  // Source 2: extension-installed MCPs in extensions-installations.json
  const ext = readJSON(MCP_EXTENSIONS_PATH);
  const extensionServers = [];
  if (ext && ext.extensions) {
    for (const extId of Object.keys(ext.extensions).sort()) {
      const e = ext.extensions[extId];
      const mcp = e?.manifest?.mcp_config || e?.manifest?.server?.mcp_config;
      if (!mcp) continue;
      extensionServers.push({
        name: e?.manifest?.name || extId,
        source: "Desktop extension",
        extId,
        command: mcp.command || "(inherited)",
        args: Array.isArray(mcp.args) ? mcp.args.slice(0, 2).join(" ") : "",
      });
    }
  }
  // Source 3: Claude Code (CLI / VS Code / Desktop terminal) stdio MCPs in ~/.claude.json
  // These were missed by the original generator — added 2026-04-25 after discovering
  // the Playwright MCP entry there wasn't being inventoried (F-08 follow-up).
  const userCfg = readJSON(CLAUDE_USER_CONFIG_PATH);
  const userServers = [];
  if (userCfg && userCfg.mcpServers) {
    for (const name of Object.keys(userCfg.mcpServers).sort()) {
      const s = userCfg.mcpServers[name];
      userServers.push({
        name,
        source: "Claude Code (~/.claude.json)",
        command: s.command || "(inherited)",
        args: Array.isArray(s.args) ? s.args.slice(0, 4).join(" ") : "",  // 4 args so "/c npx -y @pkg" is visible
      });
    }
  }

  const total = configServers.length + extensionServers.length + userServers.length;
  if (total === 0) {
    lines.push("> No MCP servers found in any of: Desktop config, Desktop extensions, or Claude Code user config");
    lines.push("");
    return lines.join("\n");
  }

  lines.push("Sources scanned:");
  lines.push(`- \`${MCP_CONFIG_PATH.replace(/\\/g, "/")}\` (Claude Desktop user config)`);
  lines.push(`- \`${MCP_EXTENSIONS_PATH.replace(/\\/g, "/")}\` (Claude Desktop installed extensions)`);
  lines.push(`- \`${CLAUDE_USER_CONFIG_PATH.replace(/\\/g, "/")}\` (Claude Code stdio MCP servers)`);
  lines.push("");
  lines.push("| Server | Source | Command | Args (first 2-4) |");
  lines.push("|---|---|---|---|");
  for (const s of [...configServers, ...extensionServers, ...userServers]) {
    lines.push(`| \`${s.name}\` | ${s.source} | \`${mdEscape(s.command)}\` | \`${mdEscape(s.args)}\` |`);
  }
  lines.push("");
  lines.push(`**Total (filesystem-enumerable):** ${total} (${configServers.length} Desktop config + ${extensionServers.length} Desktop extension + ${userServers.length} Claude Code)`);
  lines.push("");
  lines.push("> **Note:** Claude Desktop's built-in and marketplace MCP servers (e.g. memory, pdf-reader, context7, slack, figma, claude-in-chrome, claude-preview, scheduled-tasks, mcp-registry, ccd-*) are **not filesystem-discoverable** when loaded from the app bundle or a remote registry — those show as runtime-only. Claude Code's stdio MCPs (3rd row above) ARE filesystem-readable from `~/.claude.json` mcpServers. The live `/session` skill shows the full runtime list across all surfaces.");
  lines.push("");
  return lines.join("\n");
}

// ───────────────────────── Section: Hooks ─────────────────────────

const HOOK_LABELS = {
  "consolidation-guard": "Blocks writes that violate completion standards",
  "agent-oversight-guard": "Enforces subagent oversight protocol",
  "tool-validator": "Environment-aware Bash command validation",
  "read-audit": "Logs file reads to session-reads.log",
  "hook-forwarder": "Forwards events to telemetry server",
  "start-bg": "Starts telemetry background server",
  "statusline": "Custom status line display",
  "env-update-trigger": "Triggers ENVIRONMENT.html rebuild on write",
};

function labelHook(command) {
  for (const [key, label] of Object.entries(HOOK_LABELS)) {
    if (command.includes(key)) return label;
  }
  return "(no label)";
}

function sectionHooks() {
  const lines = ["## Hooks", ""];
  const settings = readJSON(config.settingsPath);
  if (!settings || !settings.hooks) {
    lines.push("> No hooks configured in `~/.claude/settings.json`");
    lines.push("");
    return lines.join("\n");
  }
  lines.push("| Phase | Matcher | Script | Purpose |");
  lines.push("|---|---|---|---|");
  let count = 0;
  for (const [phase, matchers] of Object.entries(settings.hooks)) {
    for (const matcher of matchers) {
      const target = matcher.matcher || "*";
      for (const h of (matcher.hooks || [])) {
        const cmd = h.command || "";
        const scriptMatch = cmd.match(/([^/\\"]+)\.js/);
        const script = scriptMatch ? scriptMatch[1] + ".js" : mdEscape(cmd.slice(0, 40));
        lines.push(`| \`${phase}\` | \`${target}\` | \`${script}\` | ${mdEscape(labelHook(cmd))} |`);
        count++;
      }
    }
  }
  lines.push("");
  lines.push(`**Total:** ${count} hook handler${count === 1 ? "" : "s"}`);
  if (settings.statusLine) {
    lines.push("");
    lines.push(`**Status line:** \`${mdEscape(settings.statusLine.command || settings.statusLine.type || "(configured)")}\``);
  }
  lines.push("");
  return lines.join("\n");
}

// ───────────────────────── Section: Hook Scripts ─────────────────────────

function sectionHookScripts() {
  const lines = ["## Hook Scripts", ""];
  const files = listFiles(config.scriptsDir, ".js");
  if (files.length === 0) {
    lines.push("> No scripts found in `~/.claude/scripts/`");
    lines.push("");
    return lines.join("\n");
  }
  lines.push("| Script | Size | First Line |");
  lines.push("|---|---|---|");
  for (const f of files) {
    const name = path.basename(f);
    const size = fileSize(f);
    const firstLine = readFirstLine(f);
    lines.push(`| \`${name}\` | ${size} B | ${mdEscape(firstLine).slice(0, 80)} |`);
  }
  lines.push("");
  lines.push(`**Total:** ${files.length} script${files.length === 1 ? "" : "s"}`);
  lines.push("");
  return lines.join("\n");
}

// ───────────────────────── Section: Agents ─────────────────────────

function sectionAgents() {
  const lines = ["## Agents", ""];
  const active = listFiles(config.agentsDir, ".md").map(f => {
    const fm = extractFrontmatter(f);
    return {
      name: fm.name || path.basename(f, ".md"),
      model: fm.model || "(default)",
      description: fm.description || "",
    };
  });

  const stagedDir = path.join(config.workspace, ".claude", "staged-agents");
  const staged = listFiles(stagedDir, ".md").map(f => {
    const fm = extractFrontmatter(f);
    return {
      name: fm.name || path.basename(f, ".md"),
      model: fm.model || "(default)",
      description: fm.description || "",
    };
  });

  lines.push(`### Active (${active.length})`);
  lines.push("");
  lines.push("| Agent | Model | Description |");
  lines.push("|---|---|---|");
  for (const a of active) {
    lines.push(`| \`${a.name}\` | \`${a.model}\` | ${mdEscape(a.description).slice(0, 140)} |`);
  }
  lines.push("");

  if (staged.length > 0) {
    lines.push(`### Staged (${staged.length}) — not active, copy to \`~/.claude/agents/\` to activate`);
    lines.push("");
    lines.push("| Agent | Model | Description |");
    lines.push("|---|---|---|");
    for (const a of staged) {
      lines.push(`| \`${a.name}\` | \`${a.model}\` | ${mdEscape(a.description).slice(0, 140)} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ───────────────────────── Section: Skills ─────────────────────────

function sectionSkills() {
  const lines = ["## Skills & Commands", ""];
  const skills = [];

  try {
    const entries = fs.readdirSync(config.skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(config.skillsDir, entry.name, "SKILL.md");
      if (fileExists(skillFile)) {
        const fm = extractFrontmatter(skillFile);
        skills.push({
          name: fm.name || entry.name,
          source: "user-level",
          description: fm.description || "",
        });
      }
    }
  } catch { /* no skills dir */ }

  const commandsDir = path.join(config.workspace, ".claude", "commands");
  for (const f of listFiles(commandsDir, ".md")) {
    skills.push({
      name: "/" + path.basename(f, ".md"),
      source: "workspace",
      description: "(workspace command)",
    });
  }

  if (skills.length === 0) {
    lines.push("> No skills or commands found");
    lines.push("");
    return lines.join("\n");
  }

  lines.push("| Name | Source | Description |");
  lines.push("|---|---|---|");
  for (const s of skills) {
    lines.push(`| \`${s.name}\` | ${s.source} | ${mdEscape(s.description).slice(0, 140)} |`);
  }
  lines.push("");
  lines.push(`**Total:** ${skills.length}`);
  lines.push("");
  return lines.join("\n");
}

// ───────────────────────── Section: Rules ─────────────────────────

function sectionRules() {
  const lines = ["## Rules", ""];
  const files = listFiles(config.rulesDir, ".md");
  if (files.length === 0) {
    lines.push("> No rules found in `Workspace/.claude/rules/`");
    lines.push("");
    return lines.join("\n");
  }
  lines.push(`Source: \`${config.rulesDir.replace(/\\/g, "/")}\``);
  lines.push("");
  lines.push("| File | H1 Heading |");
  lines.push("|---|---|");
  for (const f of files) {
    const name = path.basename(f, ".md");
    const firstLine = readFirstLine(f).replace(/^#\s*/, "");
    lines.push(`| \`${name}.md\` | ${mdEscape(firstLine).slice(0, 100)} |`);
  }
  lines.push("");
  lines.push(`**Total:** ${files.length} rule${files.length === 1 ? "" : "s"}`);
  lines.push("");
  return lines.join("\n");
}

// ───────────────────────── Section: Memories ─────────────────────────

function sectionMemories() {
  const lines = ["## Memories (by project)", ""];
  const projectsDir = path.join(config.claudeDir, "projects");
  const memories = [];
  try {
    const projects = fs.readdirSync(projectsDir, { withFileTypes: true });
    for (const proj of projects) {
      if (!proj.isDirectory()) continue;
      const memDir = path.join(projectsDir, proj.name, "memory");
      const memIndex = path.join(memDir, "MEMORY.md");
      if (!fileExists(memIndex)) continue;
      const content = fs.readFileSync(memIndex, "utf8");
      const entries = content.split(/\r?\n/).filter(l => l.trim().startsWith("- "));
      memories.push({ project: proj.name, count: entries.length });
    }
  } catch { /* no projects */ }

  if (memories.length === 0) {
    lines.push("> No project memories found");
    lines.push("");
    return lines.join("\n");
  }
  memories.sort((a, b) => a.project.localeCompare(b.project));
  lines.push("| Project Slug | Entries |");
  lines.push("|---|---|");
  for (const m of memories) {
    lines.push(`| \`${m.project}\` | ${m.count} |`);
  }
  lines.push("");
  lines.push(`**Total:** ${memories.length} project${memories.length === 1 ? "" : "s"} with memories`);
  lines.push("");
  return lines.join("\n");
}

// ───────────────────────── Section: Plans ─────────────────────────

function sectionPlans() {
  const lines = ["## Plans", ""];
  const plansDir = path.join(config.claudeDir, "plans");
  const files = listFiles(plansDir, ".md");
  if (files.length === 0) {
    lines.push("> No plans found in `~/.claude/plans/`");
    lines.push("");
    return lines.join("\n");
  }
  lines.push("| Plan File | First Line |");
  lines.push("|---|---|");
  for (const f of files.slice(0, 25)) {
    const name = path.basename(f);
    const firstLine = readFirstLine(f).replace(/^#\s*/, "");
    lines.push(`| \`${name}\` | ${mdEscape(firstLine).slice(0, 100)} |`);
  }
  lines.push("");
  lines.push(`**Total:** ${files.length} plan${files.length === 1 ? "" : "s"}${files.length > 25 ? " (showing first 25)" : ""}`);
  lines.push("");
  return lines.join("\n");
}

// ───────────────────────── Section: Where to Look ─────────────────────────

function sectionLookup() {
  const oversightDesignDoc = path.join(config.oversightDir, "OVERSIGHT_SYSTEM.md").replace(/\\/g, "/");
  const oversightStateDoc = path.join(config.oversightDir, "OVERSIGHT_STATE.md").replace(/\\/g, "/");
  const envDoc = OUTPUT_PATH.replace(/\\/g, "/");
  const workspaceCommands = path.join(config.workspace, ".claude", "commands").replace(/\\/g, "/");
  const workspaceClaudeMd = path.join(config.workspace, "CLAUDE.md").replace(/\\/g, "/");
  const memoriesRoot = path.join(config.claudeDir, "projects", "<slug>", "memory").replace(/\\/g, "/");
  const plansDir = path.join(config.claudeDir, "plans").replace(/\\/g, "/");

  return [
    "## Where to Look",
    "",
    "| Key | Path |",
    "|---|---|",
    `| User settings | \`${config.settingsPath.replace(/\\/g, "/")}\` |`,
    `| Hook scripts | \`${config.scriptsDir.replace(/\\/g, "/")}/\` |`,
    `| User agents | \`${config.agentsDir.replace(/\\/g, "/")}/\` |`,
    `| User skills | \`${config.skillsDir.replace(/\\/g, "/")}/\` |`,
    `| User plans | \`${plansDir}/\` |`,
    `| Memories root | \`${memoriesRoot}/\` |`,
    `| Workspace rules | \`${config.rulesDir.replace(/\\/g, "/")}/\` |`,
    `| Workspace commands | \`${workspaceCommands}/\` |`,
    `| Workspace CLAUDE.md | \`${workspaceClaudeMd}\` |`,
    `| MCP servers (Desktop) | \`${MCP_CONFIG_PATH.replace(/\\/g, "/")}\` |`,
    `| Oversight design doc | \`${oversightDesignDoc}\` |`,
    `| Oversight state (live) | \`${oversightStateDoc}\` |`,
    `| This file (source) | \`${envDoc}\` |`,
    `| This file (rendered HTML) | \`${path.join(config.workspace, "ENVIRONMENT.html").replace(/\\/g, "/")}\` |`,
    "",
  ].join("\n");
}

// ───────────────────────── Section: Footer ─────────────────────────

function sectionFooter() {
  return [
    "---",
    "",
    `Generated \`${new Date().toISOString()}\` · Rebuild manually: \`node ~/.claude/scripts/rh-generate-env-md.js\``,
    "",
  ].join("\n");
}

// ───────────────────────── Main ─────────────────────────

function main() {
  const sections = [
    sectionHeader(),
    sectionMcpServers(),
    sectionHooks(),
    sectionHookScripts(),
    sectionAgents(),
    sectionSkills(),
    sectionRules(),
    sectionMemories(),
    sectionPlans(),
    sectionLookup(),
    sectionFooter(),
  ];
  const output = sections.join("\n");

  // Ensure output dir exists
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, output, "utf8");
  console.log(`[generate-env-md] Wrote ${OUTPUT_PATH} (${output.length} bytes)`);
}

try {
  main();
  process.exit(0);
} catch (e) {
  console.error(`[generate-env-md] FAILED: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
}

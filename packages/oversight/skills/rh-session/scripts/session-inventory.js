#!/usr/bin/env node
/**
 * session-inventory.js
 * Gathers the current session's environment inventory from the filesystem.
 * Called by the /session skill. Outputs structured text for Claude to present.
 *
 * Usage: node session-inventory.js [cwd]
 *   cwd defaults to process.cwd()
 */

const fs = require("fs");
const path = require("path");
const { glob } = require("fs").promises ? {} : {};

const HOME = process.env.HOME || process.env.USERPROFILE || "";
const CLAUDE_DIR = path.join(HOME, ".claude");
// Auto-detect workspace: walk up from CWD looking for .claude/rules/
function detectWorkspace() {
  let dir = process.argv[2] || process.cwd();
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, '.claude', 'rules'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.env.CLAUDE_WORKSPACE || process.cwd();
}
const WORKSPACE = process.env.CLAUDE_WORKSPACE || detectWorkspace();

// Use provided CWD or fallback
const CWD = process.argv[2] || process.cwd();

// --- Helpers ---

function fileExists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function readFirstLine(p) {
  try {
    const content = fs.readFileSync(p, "utf8");
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("---")) return trimmed;
    }
    return "(empty)";
  } catch { return "(unreadable)"; }
}

function globSync(pattern, dir) {
  // Simple recursive glob for *.md / *.js patterns
  const results = [];
  const ext = path.extname(pattern);
  const base = pattern.replace("*" + ext, "");

  function walk(d) {
    try {
      const entries = fs.readdirSync(d, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith(ext) && (base === "" || entry.name.startsWith(base))) {
          results.push(full);
        }
      }
    } catch { /* skip unreadable dirs */ }
  }
  walk(dir);
  return results;
}

function listFiles(dir, ext) {
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith(ext))
      .map(f => path.join(dir, f));
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

// --- Sections ---

function getEntrypoint() {
  return process.env.CLAUDE_CODE_ENTRYPOINT || "(not set)";
}

// Map known hook scripts to short descriptions
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
  // Fallback: extract script filename
  const match = command.match(/([^/\\]+)\.js/);
  return match ? match[1] : command.slice(0, 50);
}

function getHooks() {
  const settings = readJSON(path.join(CLAUDE_DIR, "settings.json"));
  if (!settings || !settings.hooks) return [];
  const hooks = [];
  for (const [phase, matchers] of Object.entries(settings.hooks)) {
    for (const matcher of matchers) {
      const target = matcher.matcher || "*";
      for (const h of (matcher.hooks || [])) {
        const label = labelHook(h.command || "");
        hooks.push({ phase, target, label });
      }
    }
  }
  return hooks;
}

function getStatusLine() {
  const settings = readJSON(path.join(CLAUDE_DIR, "settings.json"));
  if (!settings || !settings.statusLine) return null;
  return settings.statusLine.command || settings.statusLine.type || "(configured)";
}

function getRules() {
  // Walk up from CWD looking for .claude/rules/ directories
  const rulesets = [];
  let dir = CWD;
  const seen = new Set();
  while (dir) {
    const rulesDir = path.join(dir, ".claude", "rules");
    const normalized = rulesDir.replace(/\\/g, "/");
    if (!seen.has(normalized) && fileExists(rulesDir)) {
      seen.add(normalized);
      const files = listFiles(rulesDir, ".md");
      rulesets.push({
        scope: dir === WORKSPACE.replace(/\//g, path.sep) || dir.replace(/\\/g, "/") === WORKSPACE ? "workspace" : dir === CWD ? "project" : "parent",
        path: rulesDir,
        rules: files.map(f => path.basename(f, ".md"))
      });
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return rulesets;
}

function getAgents() {
  const active = [];
  const staged = [];

  // User-level agents
  const agentsDir = path.join(CLAUDE_DIR, "agents");
  for (const f of listFiles(agentsDir, ".md")) {
    const fm = extractFrontmatter(f);
    active.push({
      name: fm.name || path.basename(f, ".md"),
      model: fm.model || "(default)",
      description: fm.description || ""
    });
  }

  // Staged agents
  const stagedDir = path.join(WORKSPACE, ".claude", "staged-agents");
  for (const f of listFiles(stagedDir, ".md")) {
    const fm = extractFrontmatter(f);
    staged.push({
      name: fm.name || path.basename(f, ".md"),
      model: fm.model || "(default)",
      description: fm.description || ""
    });
  }

  return { active, staged };
}

function getSkills() {
  const skills = [];
  const skillsDir = path.join(CLAUDE_DIR, "skills");
  try {
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillFile = path.join(skillsDir, entry.name, "SKILL.md");
        if (fileExists(skillFile)) {
          const fm = extractFrontmatter(skillFile);
          skills.push({
            name: fm.name || entry.name,
            description: fm.description || ""
          });
        }
      }
    }
  } catch { /* no skills dir */ }

  // Also check workspace-level commands (slash commands)
  const commandsDir = path.join(WORKSPACE, ".claude", "commands");
  for (const f of listFiles(commandsDir, ".md")) {
    skills.push({
      name: "/" + path.basename(f, ".md"),
      description: "(workspace command)"
    });
  }

  return skills;
}

function getMemories() {
  const projectsDir = path.join(CLAUDE_DIR, "projects");
  const memories = [];
  // Derive the current project slug (Claude's convention: path with -- separators)
  const cwdSlug = CWD.replace(/\\/g, "/").replace(/^([A-Z]):/, (_, d) => d.toUpperCase() + "-").replace(/\//g, "-").replace(/-$/, "");

  try {
    const projects = fs.readdirSync(projectsDir, { withFileTypes: true });
    for (const proj of projects) {
      if (!proj.isDirectory()) continue;
      const memDir = path.join(projectsDir, proj.name, "memory");
      const memIndex = path.join(memDir, "MEMORY.md");
      if (fileExists(memIndex)) {
        const content = fs.readFileSync(memIndex, "utf8");
        const entries = content.split(/\r?\n/).filter(l => l.trim().startsWith("- "));
        const isCurrent = cwdSlug === proj.name;
        memories.push({
          project: proj.name,
          count: entries.length,
          path: memDir,
          current: isCurrent
        });
      }
    }
  } catch { /* no projects dir */ }

  // Sort: current project first, then alphabetical
  memories.sort((a, b) => {
    if (a.current && !b.current) return -1;
    if (!a.current && b.current) return 1;
    return a.project.localeCompare(b.project);
  });

  return memories;
}

function getClaudeMdChain() {
  const chain = [];
  let dir = CWD;
  const seen = new Set();
  while (dir) {
    const claudeMd = path.join(dir, "CLAUDE.md");
    const normalized = claudeMd.replace(/\\/g, "/");
    if (!seen.has(normalized) && fileExists(claudeMd)) {
      seen.add(normalized);
      chain.push({
        path: claudeMd,
        scope: dir === CWD ? "project" : "parent"
      });
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return chain;
}

// --- Output ---

function formatOutput() {
  const lines = [];
  const sep = "─".repeat(60);

  lines.push("SESSION INVENTORY");
  lines.push(sep);
  lines.push("");

  // Header
  lines.push(`Entrypoint:  ${getEntrypoint()}`);
  lines.push(`CWD:         ${CWD}`);
  const sl = getStatusLine();
  if (sl) lines.push(`Status Line: active`);
  lines.push("");

  // 1. Agents
  lines.push("AGENTS");
  lines.push(sep);
  const agents = getAgents();
  if (agents.active.length === 0 && agents.staged.length === 0) {
    lines.push("  (none found)");
  } else {
    if (agents.active.length > 0) {
      lines.push("  Active:");
      for (const a of agents.active) {
        const desc = a.description ? ` — ${a.description}` : "";
        lines.push(`    ${a.name.padEnd(25)} [${a.model}]${desc}`);
      }
    }
    if (agents.staged.length > 0) {
      lines.push("  Staged:");
      for (const a of agents.staged) {
        const desc = a.description ? ` — ${a.description}` : "";
        lines.push(`    ${a.name.padEnd(25)} [${a.model}]${desc}`);
      }
    }
  }
  lines.push("");

  // 2. Hooks
  lines.push("HOOKS");
  lines.push(sep);
  const hooks = getHooks();
  if (hooks.length === 0) {
    lines.push("  (none configured)");
  } else {
    for (const h of hooks) {
      lines.push(`  ${h.phase.padEnd(20)} ${h.target.padEnd(6)} ${h.label}`);
    }
  }
  lines.push("");

  // 3. Skills & Commands
  lines.push("SKILLS & COMMANDS");
  lines.push(sep);
  const skills = getSkills();
  if (skills.length === 0) {
    lines.push("  (none found)");
  } else {
    for (const s of skills) {
      const desc = s.description ? ` — ${s.description}` : "";
      const prefix = s.name.startsWith("/") ? "  " : "  /";
      lines.push(`${prefix}${s.name}${desc}`);
    }
  }
  lines.push("");

  // 4. Rules
  lines.push("RULES");
  lines.push(sep);
  const rulesets = getRules();
  if (rulesets.length === 0) {
    lines.push("  (none found)");
  } else {
    for (const rs of rulesets) {
      lines.push(`  [${rs.scope}] ${rs.rules.length} rules: ${rs.rules.join(", ")}`);
    }
  }
  lines.push("");

  // 5. CLAUDE.md chain
  lines.push("CLAUDE.MD CHAIN");
  lines.push(sep);
  const chain = getClaudeMdChain();
  if (chain.length === 0) {
    lines.push("  (none found)");
  } else {
    for (const c of chain) {
      lines.push(`  [${c.scope}] ${c.path.replace(/\\/g, "/")}`);
    }
  }
  lines.push("");

  // 6. Memories
  lines.push("MEMORIES");
  lines.push(sep);
  const memories = getMemories();
  if (memories.length === 0) {
    lines.push("  (none found)");
  } else {
    for (const m of memories) {
      const marker = m.current ? " << CURRENT" : "";
      lines.push(`  ${m.project}: ${m.count} entries${marker}`);
    }
  }
  lines.push("");

  // 7. Runtime placeholder
  lines.push("RUNTIME");
  lines.push(sep);
  lines.push("  (model, MCP servers, deferred tools — reported by Claude)");
  lines.push("");

  return lines.join("\n");
}

console.log(formatOutput());

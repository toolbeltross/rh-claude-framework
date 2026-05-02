#!/usr/bin/env node
// daily-regen.js — orchestrates daily regeneration pipeline.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { config } = require("./lib/config");

const SCRIPTS_DIR = config.scriptsDir;
const LOG_PATH = path.join(SCRIPTS_DIR, "daily-regen.log");
const LAST_RUN_MARKER = path.join(SCRIPTS_DIR, "daily-regen.last-run");

const QUIET = process.argv.includes("--quiet");
const SKIP_IF_DONE = process.argv.includes("--skip-if-today-done");

function todayStamp() {
  return new Date().toLocaleDateString("sv-SE");
}
function alreadyRanToday() {
  try { return fs.readFileSync(LAST_RUN_MARKER, "utf8").trim() === todayStamp(); } catch { return false; }
}
function markRanToday() {
  try { fs.writeFileSync(LAST_RUN_MARKER, todayStamp(), "utf8"); } catch {}
}

function buildSteps() {
  const steps = [
    { name: "generate-env-md", cmd: "node", args: [path.join(SCRIPTS_DIR, "rh-generate-env-md.js")] },
    { name: "generate-state-md", cmd: "node", args: [path.join(SCRIPTS_DIR, "rh-generate-state-md.js")] },
  ];

  // HTML rendering steps — only if oversightDir is configured and render script exists
  const renderScript = path.join(SCRIPTS_DIR, "rh-render-md-html.js");
  if (fs.existsSync(renderScript) && config.oversightDir) {
    const envMd = path.join(config.oversightDir, "..", "environment", "ENVIRONMENT.md");
    const stateMd = path.join(config.oversightDir, "OVERSIGHT_STATE.md");
    const systemMd = path.join(config.oversightDir, "OVERSIGHT_SYSTEM.md");

    if (fs.existsSync(envMd)) {
      steps.push({
        name: "render-env-html", cmd: "node",
        args: [renderScript, "--in", envMd, "--out", path.join(config.workspace, "ENVIRONMENT.html"), "--title", `Claude Code Environment — ${config.userName}`],
      });
    }
    if (fs.existsSync(stateMd)) {
      steps.push({
        name: "render-state-html", cmd: "node",
        args: [renderScript, "--in", stateMd, "--out", path.join(config.workspace, "OVERSIGHT_STATE.html"), "--title", "Oversight System — Current State"],
      });
    }
    if (fs.existsSync(systemMd)) {
      steps.push({
        name: "render-system-html", cmd: "node",
        args: [renderScript, "--in", systemMd, "--out", path.join(config.workspace, "OVERSIGHT_SYSTEM.html"), "--title", "Oversight System — Design Spec", "--skip-if-unchanged"],
      });
    }
  }

  const checkGuidance = path.join(SCRIPTS_DIR, "rh-check-anthropic-guidance.js");
  if (fs.existsSync(checkGuidance)) {
    steps.push({ name: "check-anthropic-guidance", cmd: "node", args: [checkGuidance] });
  }

  steps.push({ name: "hook-perf-audit", cmd: "node", args: [path.join(SCRIPTS_DIR, "lib", "hook-perf-audit.js")] });

  const selfTest = path.join(SCRIPTS_DIR, "rh-oversight-self-test.js");
  if (fs.existsSync(selfTest)) {
    steps.push({ name: "oversight-self-test", cmd: "node", args: [selfTest] });
  }

  return steps;
}

function runStep(step) {
  const start = Date.now();
  try {
    const res = spawnSync(step.cmd, step.args, { encoding: "utf8", windowsHide: true, timeout: 60_000 });
    const ms = Date.now() - start;
    if (res.status === 0) return { name: step.name, ok: true, ms, stdout: (res.stdout || "").trim(), stderr: "" };
    return { name: step.name, ok: false, ms, stdout: (res.stdout || "").trim(), stderr: (res.stderr || "").trim() || `exit code ${res.status}` };
  } catch (e) {
    return { name: step.name, ok: false, ms: Date.now() - start, stdout: "", stderr: e.message };
  }
}

function log(line) {
  if (!QUIET) console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + "\n", "utf8"); } catch {}
}

function main() {
  if (SKIP_IF_DONE && alreadyRanToday()) {
    log(`\n==== daily-regen skipped ${new Date().toISOString()} — already ran for ${todayStamp()} ====`);
    process.exit(0);
  }

  log(`\n==== daily-regen run ${new Date().toISOString()} ====`);

  const steps = buildSteps();
  const results = [];
  for (const step of steps) {
    const r = runStep(step);
    results.push(r);
    let status = r.ok ? "OK  " : "FAIL";
    if (r.ok && /Skipped/i.test(r.stdout)) status = "SKIP";
    log(`[${status}] ${r.name.padEnd(26)} ${r.ms.toString().padStart(5)} ms`);
    if (!r.ok && r.stderr) log(`       stderr: ${r.stderr.split("\n")[0].slice(0, 200)}`);
  }

  const okCount = results.filter(r => r.ok).length;
  const failCount = results.length - okCount;
  log(`==== completed ${new Date().toISOString()} — ${okCount}/${results.length} ok, ${failCount} failed ====`);

  if (failCount === 0) markRanToday();
  process.exit(failCount === 0 ? 0 : 2);
}

main();

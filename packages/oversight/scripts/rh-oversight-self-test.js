#!/usr/bin/env node
/**
 * oversight-self-test.js
 *
 * F-04: daily smoke test that confirms the oversight enforcement hooks still
 * fire on known-violating fixtures. Catches silent regressions where a hook
 * stops blocking what it should — e.g., consolidation-guard.js no longer
 * checking for source registry, agent-oversight-guard.js no longer auto-injecting,
 * etc.
 *
 * Run as a step inside daily-regen.js. Failures append a line to daily-regen.log.
 *
 * Test groups:
 *   1. Behavior tests — auto-inject branches, consolidation block, agent-result
 *      pattern detection. (Original F-04 coverage.)
 *   2. Robustness tests — every guard script handles malformed JSON without
 *      crashing or fail-closing. (Added 2026-04-25 for #5.)
 *   3. Syntax check — every hook script parses with `node --check`. (#5)
 *   4. Hook health probe — calls /api/hook-health and flags healthy:false. (#6)
 *
 * Each test runs in <1s with no network or filesystem side-effects against
 * live state. Self-test is purely synthetic; it does not exercise live hooks
 * via the actual settings.json wire-up.
 */

const { spawnSync } = require("child_process");
const path = require("path");
const http = require("http");
const { config } = require('./lib/config');

const SCRIPTS_DIR = path.join(config.claudeDir, "scripts");
// ─── Helpers ──────────────────────────────────────────────────────────────

function runHook(scriptPath, stdinJson) {
  const inputBuf = stdinJson === null ? "" : (typeof stdinJson === "string" ? stdinJson : JSON.stringify(stdinJson));
  const res = spawnSync("node", [scriptPath], {
    input: inputBuf,
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
    // OVERSIGHT_SELF_TEST=1 tells the guards to skip notifyTelemetry POSTs.
    // Otherwise every daily-regen self-test would pollute the failure feed
    // with synthetic events.
    env: { ...process.env, OVERSIGHT_SELF_TEST: "1" },
  });
  return {
    exitCode: res.status,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
  };
}

function syntaxCheck(scriptPath) {
  const res = spawnSync("node", ["--check", scriptPath], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });
  return { ok: res.status === 0, stderr: res.stderr || "" };
}

function getJson(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.request(url, { method: "GET", timeout: timeoutMs || 1500 }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        try { resolve({ ok: true, json: JSON.parse(data) }); }
        catch (e) { resolve({ ok: false, error: `parse: ${e.message}` }); }
      });
    });
    req.on("error", (e) => resolve({ ok: false, error: e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "timeout" }); });
    req.end();
  });
}

// ─── Test definitions ──────────────────────────────────────────────────────

const GUARD_SCRIPTS = [
  "rh-agent-oversight-guard.js",
  "rh-consolidation-guard.js",
  "rh-agent-result-guard.js",
  "rh-read-audit.js",
  "rh-layer3a-capture.js",
  "rh-scribe-prefilter.js",
  "rh-agents-loaded-marker.js",
  "rh-oversight-self-test.js",
  "rh-generate-state-md.js",
  "rh-daily-regen.js",
];

const BEHAVIOR_TESTS = [
  {
    name: "agent-oversight-guard / missing block → auto-injects",
    run: () => {
      const r = runHook(path.join(SCRIPTS_DIR, "rh-agent-oversight-guard.js"), {
        tool_input: { prompt: "Read a file and return its contents", description: "test", subagent_type: "general-purpose" }
      });
      if (r.exitCode !== 0) return { pass: false, reason: `exit ${r.exitCode}: ${r.stderr.slice(0, 200)}` };
      let out;
      try { out = JSON.parse(r.stdout || "{}"); } catch (e) { return { pass: false, reason: `JSON parse: ${e.message}` }; }
      const decision = out?.hookSpecificOutput?.permissionDecision;
      const updated = out?.hookSpecificOutput?.updatedInput?.prompt || "";
      const injected = /Required oversight block.*auto-injected/i.test(updated);
      if (decision !== "allow") return { pass: false, reason: `expected permissionDecision=allow, got ${decision}` };
      if (!injected) return { pass: false, reason: `updatedInput.prompt does not contain auto-injected block marker` };
      return { pass: true };
    },
  },
  {
    name: "agent-oversight-guard / block present → no mutation",
    run: () => {
      const r = runHook(path.join(SCRIPTS_DIR, "rh-agent-oversight-guard.js"), {
        tool_input: {
          prompt: "Read a file. Required: verification token (last line verbatim plus total line count and lines read), telemetry with #compactions and % used, batch overflow rule (STOP and return remaining count).",
          description: "test",
          subagent_type: "general-purpose",
        }
      });
      if (r.exitCode !== 0) return { pass: false, reason: `exit ${r.exitCode}: ${r.stderr.slice(0, 200)}` };
      let out;
      try { out = JSON.parse(r.stdout || "{}"); } catch (e) { return { pass: false, reason: `JSON parse: ${e.message}` }; }
      if (out && out.hookSpecificOutput) return { pass: false, reason: `expected empty {}, got ${JSON.stringify(out).slice(0, 120)}` };
      return { pass: true };
    },
  },
  {
    name: "consolidation-guard / consolidation file missing registry → block",
    run: () => {
      const r = runHook(path.join(SCRIPTS_DIR, "rh-consolidation-guard.js"), {
        tool_input: { file_path: "/tmp/MASTER_TEST.md", content: "# Test consolidation\n\nNo registry here." }
      });
      if (r.exitCode !== 0) return { pass: false, reason: `exit ${r.exitCode}` };
      let out;
      try { out = JSON.parse(r.stdout || "{}"); } catch (e) { return { pass: false, reason: `JSON parse: ${e.message}` }; }
      if (out.decision !== "block") return { pass: false, reason: `expected decision=block, got ${out.decision}` };
      return { pass: true };
    },
  },
  {
    name: "consolidation-guard / non-consolidation file → allow",
    run: () => {
      const r = runHook(path.join(SCRIPTS_DIR, "rh-consolidation-guard.js"), {
        tool_input: { file_path: "/tmp/notes.md", content: "Just notes." }
      });
      if (r.exitCode !== 0) return { pass: false, reason: `exit ${r.exitCode}` };
      let out;
      try { out = JSON.parse(r.stdout || "{}"); } catch (e) { return { pass: false, reason: `JSON parse: ${e.message}` }; }
      if (out.decision !== "allow") return { pass: false, reason: `expected decision=allow, got ${out.decision}` };
      return { pass: true };
    },
  },
  {
    name: "agent-result-guard / no failure patterns → empty pass",
    run: () => {
      const r = runHook(path.join(SCRIPTS_DIR, "rh-agent-result-guard.js"), {
        tool_input: { description: "research analyst" },
        tool_output: "Found 5 sources, processed 5, failures: 0. Compactions: 0. Context: 18%.",
      });
      if (r.exitCode !== 0) return { pass: false, reason: `exit ${r.exitCode}` };
      let out;
      try { out = JSON.parse(r.stdout || "{}"); } catch (e) { return { pass: false, reason: `JSON parse: ${e.message}` }; }
      if (out.decision === "block") return { pass: false, reason: `unexpected block: ${out.reason?.slice(0, 100)}` };
      return { pass: true };
    },
  },
  {
    name: "agent-result-guard / zero-sources pattern → block",
    run: () => {
      const r = runHook(path.join(SCRIPTS_DIR, "rh-agent-result-guard.js"), {
        tool_input: { description: "research analyst" },
        tool_output: "Search returned no results. Sources found: 0. Successfully processed: 0.",
      });
      if (r.exitCode !== 0) return { pass: false, reason: `exit ${r.exitCode}` };
      let out;
      try { out = JSON.parse(r.stdout || "{}"); } catch (e) { return { pass: false, reason: `JSON parse: ${e.message}` }; }
      if (out.decision !== "block") return { pass: false, reason: `expected block, got ${out.decision}` };
      return { pass: true };
    },
  },
];

// Robustness tests: every guard script must handle malformed JSON without
// crashing (exit 0) and emit a parsable JSON output (or empty).
const ROBUSTNESS_SCRIPTS = [
  "rh-agent-oversight-guard.js",
  "rh-consolidation-guard.js",
  "rh-agent-result-guard.js",
  "rh-read-audit.js",
  "rh-layer3a-capture.js",
  "rh-scribe-prefilter.js",
  "rh-agents-loaded-marker.js",
];

function buildRobustnessTests() {
  const malformedInputs = [
    { label: "empty stdin", input: "" },
    { label: "garbage text", input: "this is not JSON {{" },
    { label: "truncated JSON", input: '{"tool_input":' },
  ];
  const tests = [];
  for (const script of ROBUSTNESS_SCRIPTS) {
    for (const m of malformedInputs) {
      tests.push({
        name: `${script} / ${m.label} → no crash, parsable output`,
        run: () => {
          const r = runHook(path.join(SCRIPTS_DIR, script), m.input);
          if (r.exitCode !== 0) return { pass: false, reason: `exit ${r.exitCode}: ${r.stderr.slice(0, 150)}` };
          if (!r.stdout) return { pass: false, reason: "empty stdout (should emit at least '{}')" };
          try {
            JSON.parse(r.stdout);
          } catch (e) {
            return { pass: false, reason: `stdout not parsable: ${r.stdout.slice(0, 100)}` };
          }
          return { pass: true };
        },
      });
    }
  }
  return tests;
}

function buildSyntaxTests() {
  return GUARD_SCRIPTS.map(script => ({
    name: `syntax / ${script}`,
    run: () => {
      const r = syntaxCheck(path.join(SCRIPTS_DIR, script));
      if (!r.ok) return { pass: false, reason: r.stderr.split("\n")[0].slice(0, 200) };
      return { pass: true };
    },
  }));
}

async function runHookHealthProbe() {
  const url = `http://localhost:${config.telemetryPort}/api/hook-health`;
  const res = await getJson(url, 1500);
  if (!res.ok) {
    // Server down is not a self-test failure — telemetry server is optional.
    return { name: "hook-health probe / server reachable", pass: true, info: `server unreachable (${res.error}) — skipped` };
  }
  const j = res.json;
  if (j?.healthy === false) {
    const errs = (j.recentErrors || []).slice(0, 1).map(e => e.slice(0, 120)).join(" | ");
    return {
      name: "hook-health probe / healthy:true",
      pass: false,
      reason: `hook-forwarder reports healthy:false. Reason: ${j.reason || "(none)"}. Sample: ${errs}`,
    };
  }
  return { name: "hook-health probe / healthy:true", pass: true };
}

/**
 * Soft probe: detect doc-sync drift per Workspace/.claude/rules/rh-oversight-doc-sync.md.
 * Compares max mtime across the rule's "trigger surfaces" (oversight enforcement
 * scripts, agents, rules, settings.json, hook-forwarder) against the mtime of the
 * hand-authored design doc. If any trigger surface is newer, the design doc is
 * stale relative to the code — emit a soft warning listing the offenders.
 *
 * This is a SOFT probe (exit 0 even on warning). Doc-sync drift is a hygiene
 * issue, not a regression. Treating it as a hard fail would block daily-regen
 * any time we edited oversight code without immediately updating the design doc.
 */
const fs = require("fs");
function statMtimeMs(p) {
  try { return fs.statSync(p).mtimeMs; } catch { return null; }
}
function listMdFiles(dir) {
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith(".md") || f.endsWith(".js"))
      .map(f => path.join(dir, f));
  } catch { return []; }
}
function runDocSyncProbe() {
  const DESIGN_DOC = path.join(config.oversightDir, "OVERSIGHT_SYSTEM.md");
  const designMtime = statMtimeMs(DESIGN_DOC);
  if (designMtime === null) {
    return { name: "doc-sync probe / design doc readable", pass: true, info: "OVERSIGHT_SYSTEM.md not found — skipped" };
  }

  const triggerSurfaces = [
    ...listMdFiles(SCRIPTS_DIR),
    ...listMdFiles(path.join(SCRIPTS_DIR, "lib")),
    ...listMdFiles(path.join(config.claudeDir, "agents")),
    ...listMdFiles(config.rulesDir),
    path.join(config.claudeDir, "settings.json"),
    path.join(config.workspace, "toolbeltross", "toolbeltross-public", "rh-telemetry", "scripts", "hook-forwarder.js"),
  ];

  const newer = [];
  for (const f of triggerSurfaces) {
    const m = statMtimeMs(f);
    if (m !== null && m > designMtime) {
      newer.push({ path: f, ageHours: (m - designMtime) / (1000 * 60 * 60) });
    }
  }

  if (newer.length === 0) {
    return { name: "doc-sync probe / design doc current vs trigger surfaces", pass: true };
  }

  // Sort newest-first, surface the top offenders.
  newer.sort((a, b) => b.ageHours - a.ageHours);
  const top = newer.slice(0, 3).map(n => {
    const rel = n.path.replace(config.workspace, "<workspace>").replace(config.home, "~");
    return `${rel} (+${n.ageHours.toFixed(1)}h)`;
  }).join(", ");
  return {
    name: "doc-sync probe / design doc current vs trigger surfaces",
    pass: false,
    reason: `${newer.length} trigger surface(s) newer than OVERSIGHT_SYSTEM.md. Top: ${top}. Per oversight-doc-sync.md, update the design doc.`,
  };
}

function runHookPerfProbe() {
  const perfLog = path.join(config.claudeDir, "hook-perf.jsonl");
  try {
    const fs = require("fs");
    if (!fs.existsSync(perfLog)) {
      return { name: "hook-perf probe / data exists", pass: false, reason: "hook-perf.jsonl not found — hooks may not be instrumented" };
    }
    const content = fs.readFileSync(perfLog, "utf8");
    const lines = content.split("\n").filter(Boolean);
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const recent = [];
    for (const line of lines.slice(-200)) {
      try {
        const r = JSON.parse(line);
        if (r.ts >= since) recent.push(r);
      } catch {}
    }
    if (recent.length === 0) {
      return { name: "hook-perf probe / recent data", pass: false, reason: "no hook-perf records in last 24h" };
    }
    const extreme = recent.filter(r => r.durationMs > 1000);
    if (extreme.length > 0) {
      const worst = extreme.sort((a, b) => b.durationMs - a.durationMs)[0];
      return { name: "hook-perf probe / latency", pass: false, reason: `${extreme.length} invocation(s) > 1000ms — worst: ${worst.hook} at ${worst.durationMs}ms` };
    }
    const hooks = new Set(recent.map(r => r.hook));
    return { name: "hook-perf probe / latency", pass: true, info: `${hooks.size} hooks, ${recent.length} records (24h), all < 1000ms` };
  } catch (e) {
    return { name: "hook-perf probe / read", pass: false, reason: e.message };
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  // HARD tests — these check oversight-system code itself. A failure here
  // means a real regression in our enforcement scripts. Exit 2 on any fail.
  const hardTests = [
    ...BEHAVIOR_TESTS,
    ...buildRobustnessTests(),
    ...buildSyntaxTests(),
  ];

  const hardResults = [];
  for (const t of hardTests) {
    let r;
    try { r = t.run(); } catch (e) { r = { pass: false, reason: `threw: ${e.message}` }; }
    hardResults.push({ name: t.name, ...r });
  }

  // SOFT probes — these surface live environment health (e.g., hook-forwarder
  // unhealthy) or hygiene drift (e.g., design doc lagging behind code edits).
  // Failures here are real signal but NOT regressions of our code, so they
  // don't trip exit 2 (which would otherwise pollute Bash-failure feeds when
  // daily-regen invokes us). Reported as [WARN] in output.
  const softResults = [];
  softResults.push(await runHookHealthProbe());
  softResults.push(runDocSyncProbe());
  softResults.push(runHookPerfProbe());

  const allResults = [...hardResults, ...softResults];
  const hardPassed = hardResults.filter(r => r.pass).length;
  const hardFailed = hardResults.length - hardPassed;
  const softPassed = softResults.filter(r => r.pass).length;
  const softFailed = softResults.length - softPassed;

  for (const r of hardResults) {
    const status = r.pass ? "PASS" : "FAIL";
    const suffix = r.pass ? (r.info ? ` — ${r.info}` : "") : ` — ${r.reason}`;
    console.log(`[${status}] ${r.name}${suffix}`);
  }
  for (const r of softResults) {
    const status = r.pass ? "PASS" : "WARN";
    const suffix = r.pass ? (r.info ? ` — ${r.info}` : "") : ` — ${r.reason}`;
    console.log(`[${status}] ${r.name}${suffix}`);
  }
  console.log(
    `oversight-self-test: ${hardPassed}/${hardResults.length} hard passed` +
    (hardFailed ? `, ${hardFailed} HARD-FAILED` : "") +
    (softFailed ? `, ${softFailed} soft warning(s)` : "")
  );
  // Exit 2 only on hard regressions. Soft warnings are signal, not failure.
  process.exit(hardFailed ? 2 : 0);
}

main().catch(e => {
  console.error(`oversight-self-test crashed: ${e.message}`);
  process.exit(2);
});

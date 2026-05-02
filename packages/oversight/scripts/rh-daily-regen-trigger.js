#!/usr/bin/env node
// daily-regen-trigger.js — SessionStart hook.
// Fires daily-regen.js with --skip-if-today-done in a detached process.

const { spawn } = require("child_process");
const path = require("path");

const SCRIPT = path.join(__dirname, "rh-daily-regen.js");

try {
  const child = spawn("node", [SCRIPT, "--skip-if-today-done", "--quiet"], {
    detached: true, stdio: "ignore", windowsHide: true,
  });
  child.unref();
} catch {}
process.exit(0);

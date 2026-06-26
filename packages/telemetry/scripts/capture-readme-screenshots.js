#!/usr/bin/env node
/**
 * Phase F1 — capture canonical README screenshots.
 *
 * Spawns a throwaway telemetry server in test-mode, seeds representative
 * state for each phenomenon the README describes, and captures a PNG
 * per scenario into `docs/screenshots/`.
 *
 * Run once after a `npm run build` (so `dist/` is current):
 *   node scripts/capture-readme-screenshots.js
 *
 * Screenshots are deterministic-ish — same seed data each time, same
 * layout — so re-running should produce the same images modulo OS font
 * differences. Safe to re-run; overwrites in place.
 *
 * Isolation: uses a tmp HOME + ephemeral port via the existing test
 * harness helpers so the developer's live :7890 server is untouched.
 */
import { chromium } from 'playwright';
import { mkdirSync, copyFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { startTestServer, postJson } from '../tests/helpers/server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const FIXTURES = join(PROJECT_ROOT, 'tests', 'fixtures');
const OUT_DIR = join(PROJECT_ROOT, 'docs', 'screenshots');
const DIST_PATH = join(PROJECT_ROOT, 'dist');

const VIEWPORT = { width: 1600, height: 900 };

async function pushState(baseUrl, method, args) {
  return postJson(`${baseUrl}/api/_test/state`, { method, args });
}

async function clickSubTab(page, name) {
  const btn = page.locator(`button:has-text("${name}")`).first();
  await btn.click();
  await page.waitForTimeout(250);
}

function mkTmpHome() {
  const home = join(tmpdir(), `ct-screenshots-${randomUUID().slice(0, 8)}`);
  mkdirSync(join(home, '.claude'), { recursive: true });
  const healthyFixture = join(FIXTURES, 'settings', 'healthy.json');
  copyFileSync(healthyFixture, join(home, '.claude', 'settings.json'));
  return home;
}

// ─────────────────────────────────────────────────────────────────────
// Scenarios — each produces one PNG in docs/screenshots/.
// Each builds on a fresh server so states don't bleed into each other.
// ─────────────────────────────────────────────────────────────────────

async function scenario({ name, seed, focus }) {
  console.log(`\n→ ${name}`);
  const home = mkTmpHome();
  const server = await startTestServer({
    tmpHome: home,
    extraEnv: { RH_TELEMETRY_TEST_MODE: '1' },
  });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();

  try {
    await page.goto(server.baseUrl, { waitUntil: 'networkidle', timeout: 5000 });
    await seed(server);
    await page.waitForTimeout(500);
    await focus(page);
    const out = join(OUT_DIR, `${name}.png`);
    await page.screenshot({ path: out, fullPage: false });
    console.log(`   wrote ${out}`);
  } finally {
    await context.close();
    await browser.close();
    await server.stop();
  }
}

const SID = 'readme-demo';

async function seedBaseSession(baseUrl, { ctxPct = 25, cost = 1.0, totalTokens = 50_000 } = {}) {
  await postJson(`${baseUrl}/api/status`, {
    session_id: SID,
    model: { id: 'claude-opus-4-6', display_name: 'Opus 4.6' },
    cost: { total_cost_usd: cost },
    context_window: {
      context_window_size: 200_000,
      total_input_tokens: totalTokens,
      used_percentage: ctxPct,
      current_usage: {
        input_tokens: 3_000,
        output_tokens: 400,
        cache_read_input_tokens: totalTokens - 3_400,
        cache_creation_input_tokens: 5_000,
      },
    },
    workspace: { current_dir: '/Users/demo/projects/rh-telemetry' },
    _source: 'statusLine',
  });
  await postJson(`${baseUrl}/api/prompt`, {
    session_id: SID,
    prompt: 'refactor the parser to handle the new model IDs and rerun the test suite',
  });
}

async function main() {
  if (!existsSync(DIST_PATH)) {
    console.error('dist/ not found — run `npm run build` first.');
    process.exit(1);
  }
  mkdirSync(OUT_DIR, { recursive: true });

  // 1) Agents tab — orphaned + compacted chip
  await scenario({
    name: 'agents-orphaned',
    seed: async (srv) => {
      await seedBaseSession(srv.baseUrl, { ctxPct: 55, cost: 4.28 });
      // One healthy completed agent
      await postJson(`${srv.baseUrl}/api/subagent`, {
        session_id: SID, action: 'start', agent_id: 'explore-ok', agent_type: 'Explore',
      });
      for (let i = 0; i < 6; i++) {
        await postJson(`${srv.baseUrl}/api/hooks`, {
          tool_name: i % 2 === 0 ? 'Read' : 'Grep', session_id: SID, agent_id: 'explore-ok', success: true,
        });
      }
      await postJson(`${srv.baseUrl}/api/subagent`, {
        session_id: SID, action: 'stop', agent_id: 'explore-ok', agent_type: 'Explore',
        _transcriptMetrics: {
          status: 'ok',
          model: { id: 'claude-haiku-4-5', display_name: 'Haiku 4.5' },
          cost: { total_cost_usd: 0.024 },
          tokens: { input: 8_200, output: 1_200, cacheRead: 45_000, cacheWrite: 0, total: 9_400 },
          turns: 4,
        },
      });

      // One facilitator that will end up stuck across a compaction
      await postJson(`${srv.baseUrl}/api/subagent`, {
        session_id: SID, action: 'start', agent_id: 'facilitator-stuck', agent_type: 'facilitator',
      });
      await postJson(`${srv.baseUrl}/api/hooks`, {
        tool_name: 'Task', session_id: SID, agent_id: 'facilitator-stuck', success: true,
      });

      // Compaction fires while facilitator is active
      await postJson(`${srv.baseUrl}/api/compact`, { session_id: SID, trigger: 'auto' });

      // Backdate the stuck agent so the orphan sweep picks it up
      await pushState(srv.baseUrl, '_promptContextFor', [SID]); // warm up
      // Set startedAt back in time via _test/state — we call addToolEvent to set _lastToolAt, then sweep
      // Easier: just call sweepOrphanedSubagents with threshold=0
      await pushState(srv.baseUrl, 'sweepOrphanedSubagents', [0]);
    },
    focus: async (page) => {
      await clickSubTab(page, 'Agents');
      // Expand completed details so the orphaned chip is visible
      const toggle = page.locator('button', { hasText: /Show completed agent details/ }).first();
      if (await toggle.count()) {
        await toggle.click();
        await page.waitForTimeout(200);
      }
    },
  });

  // 2) Stop-hook loop banner
  await scenario({
    name: 'stop-hook-loop',
    seed: async (srv) => {
      await seedBaseSession(srv.baseUrl, { ctxPct: 42, cost: 2.15 });
      // 3 forced continuations in a row
      for (let i = 0; i < 3; i++) {
        await postJson(`${srv.baseUrl}/api/turn-end`, { session_id: SID });
        await postJson(`${srv.baseUrl}/api/hooks`, {
          tool_name: i === 0 ? 'Read' : i === 1 ? 'Grep' : 'Bash',
          session_id: SID,
          success: true,
        });
      }
    },
    focus: async () => {},  // banner lives at the top of SessionTab, always visible
  });

  // 3) Events & Failures — mixed colors
  await scenario({
    name: 'events-and-failures',
    seed: async (srv) => {
      await seedBaseSession(srv.baseUrl, { ctxPct: 48, cost: 3.40 });
      // Tool failure — ENOENT, retried twice
      const readFail = {
        tool_name: 'Read', session_id: SID, event_type: 'post_tool_use_failure',
        success: false, error: 'ENOENT: no such file /tmp/missing.yaml',
        tool_input: { file_path: '/tmp/missing.yaml' },
      };
      await postJson(`${srv.baseUrl}/api/hooks`, readFail);
      await postJson(`${srv.baseUrl}/api/hooks`, readFail);
      // A different real failure
      await postJson(`${srv.baseUrl}/api/hooks`, {
        tool_name: 'Bash', session_id: SID, event_type: 'post_tool_use_failure',
        success: false, error: 'EACCES: permission denied /etc/secret',
        tool_input: { command: 'cat /etc/secret' },
      });
      // Validation block
      await postJson(`${srv.baseUrl}/api/hooks`, {
        tool_name: 'Bash', session_id: SID, event_type: 'validation_block',
        success: false, error: '[BLOCK] cat → use Read tool instead',
      });
      // Validation suggestion (green)
      await postJson(`${srv.baseUrl}/api/hooks`, {
        tool_name: 'Bash', session_id: SID, event_type: 'validation_suggest',
        success: false, error: '[SUGGEST] grep → prefer Grep tool',
      });
      // Config change
      await postJson(`${srv.baseUrl}/api/config-change`, {
        session_id: SID,
        config_path: '/Users/demo/.claude/settings.json',
        changes: { hooks: 'modified' },
      });
    },
    focus: async (page) => {
      await clickSubTab(page, 'Failures');
    },
  });

  // 4) Context Window at higher utilization
  await scenario({
    name: 'context-window',
    seed: async (srv) => {
      await seedBaseSession(srv.baseUrl, { ctxPct: 72, cost: 5.80, totalTokens: 144_000 });
      // Push a few context history points to make the gauge look lived-in
      for (const pct of [12, 23, 41, 55, 68, 72]) {
        await postJson(`${srv.baseUrl}/api/status`, {
          session_id: SID,
          model: { id: 'claude-opus-4-6', display_name: 'Opus 4.6' },
          cost: { total_cost_usd: 5.80 },
          context_window: {
            context_window_size: 200_000,
            total_input_tokens: Math.round(200_000 * pct / 100),
            used_percentage: pct,
            current_usage: {
              input_tokens: 3_000, output_tokens: 400,
              cache_read_input_tokens: Math.round(200_000 * pct / 100) - 3_400,
              cache_creation_input_tokens: 5_000,
            },
          },
          workspace: { current_dir: '/Users/demo/projects/rh-telemetry' },
          _source: 'statusLine',
        });
      }
    },
    focus: async () => {},  // ContextWindow panel is Row 1 — already visible
  });

  // 5) Cost breakdown — Opus parent + subagents on various models
  await scenario({
    name: 'cost-breakdown',
    seed: async (srv) => {
      await seedBaseSession(srv.baseUrl, { ctxPct: 38, cost: 6.94 });
      const agents = [
        { id: 'a1', type: 'Explore', model: 'Haiku 4.5', modelId: 'claude-haiku-4-5', cost: 0.03 },
        { id: 'a2', type: 'Plan', model: 'Sonnet 4.6', modelId: 'claude-sonnet-4-6', cost: 0.24 },
        { id: 'a3', type: 'general-purpose', model: 'Opus 4.6', modelId: 'claude-opus-4-6', cost: 1.18 },
        { id: 'a4', type: 'Explore', model: 'Haiku 4.5', modelId: 'claude-haiku-4-5', cost: 0.05 },
        { id: 'a5', type: 'research-analyst', model: 'Sonnet 4.6', modelId: 'claude-sonnet-4-6', cost: 0.31 },
      ];
      for (const a of agents) {
        await postJson(`${srv.baseUrl}/api/subagent`, { session_id: SID, action: 'start', agent_id: a.id, agent_type: a.type });
        for (let i = 0; i < 3; i++) {
          await postJson(`${srv.baseUrl}/api/hooks`, { tool_name: 'Read', session_id: SID, agent_id: a.id, success: true });
        }
        await postJson(`${srv.baseUrl}/api/subagent`, {
          session_id: SID, action: 'stop', agent_id: a.id, agent_type: a.type,
          _transcriptMetrics: {
            status: 'ok',
            model: { id: a.modelId, display_name: a.model },
            cost: { total_cost_usd: a.cost },
            tokens: { input: 4_000, output: 800, cacheRead: 30_000, cacheWrite: 0, total: 4_800 },
            turns: 3,
          },
        });
      }
    },
    focus: async (page) => {
      await clickSubTab(page, 'Agents');
    },
  });

  // 6) Failure patterns view — class chips + top-cost
  await scenario({
    name: 'failure-patterns',
    seed: async (srv) => {
      await seedBaseSession(srv.baseUrl, { ctxPct: 34, cost: 2.80 });
      // Seed a mix so the class breakdown is varied
      const patterns = [
        { tool: 'Read', error: 'ENOENT: no such file', cost: 0.018 },
        { tool: 'Read', error: 'ENOENT: no such file', cost: 0.018 }, // retry
        { tool: 'Read', error: 'ENOENT: no such file', cost: 0.018 }, // retry
        { tool: 'Bash', error: 'EACCES: permission denied', cost: 0.12 },
        { tool: 'Bash', error: 'EACCES: permission denied', cost: 0.12 },
        { tool: 'Read', error: 'Response exceeds 256KB limit', cost: 0.45 },
        { tool: 'Read', error: 'Response exceeds 256KB limit', cost: 0.38 },
        { tool: 'Bash', error: 'Command timed out after 120000ms', cost: 0.22 },
      ];
      for (const p of patterns) {
        await postJson(`${srv.baseUrl}/api/hooks`, {
          tool_name: p.tool, session_id: SID, event_type: 'post_tool_use_failure',
          success: false, error: p.error, tool_input: { ref: p.error.slice(0, 20) },
          estimated_cost: p.cost,
        });
      }
    },
    focus: async (page) => {
      await clickSubTab(page, 'Failures');
    },
  });

  // 7) Hook-health chip (green path — healthy)
  await scenario({
    name: 'hook-health',
    seed: async (srv) => {
      await seedBaseSession(srv.baseUrl, { ctxPct: 28, cost: 0.84 });
      // Write a synthetic hook-debug.log in the project root so health check picks it up.
      // The hook-health module reads PROJECT_ROOT/hook-debug.log — we can't change that path.
      // So we'll just post a mix of failures that don't trigger the unhealthy state.
      await postJson(`${srv.baseUrl}/api/hooks`, {
        tool_name: 'Read', session_id: SID, event_type: 'validation_suggest',
        success: false, error: '[SUGGEST] Use Read instead of cat',
      });
    },
    focus: async (page) => {
      await clickSubTab(page, 'Failures');
    },
  });

  console.log('\nAll screenshots written to docs/screenshots/');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

#!/usr/bin/env node
// Standalone Claude Code statusline — based on statusline-script.md
// Temporary until claude-telemetry is installed and configured.
// Reads JSON from stdin, outputs 2-3 line ANSI-formatted status.

const DEFAULT_CONTEXT_WINDOW_SIZE = 200000;

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8').trim();
}

(async () => {
  try {
    const raw = await readStdin();
    if (!raw) { process.stdout.write('Claude Code\n'); return; }

    const input = JSON.parse(raw);

    // -- Extract data from statusline JSON --
    const modelFull = input.model?.display_name || '?';
    const model = modelFull.replace(/\s*\(.*\)/, '');
    const cost = (input.cost?.total_cost_usd || 0).toFixed(2);
    const ctxPct = Math.round(input.context_window?.used_percentage || 0);

    // At session start (no cost, no context used), output plain text to avoid
    // ANSI/unicode wrapping before Claude Code's UI is fully laid out
    if (ctxPct === 0 && cost === '0.00') {
      process.stdout.write(`${model}\n`);
      return;
    }
    const ctxWindowSize = input.context_window?.context_window_size || DEFAULT_CONTEXT_WINDOW_SIZE;
    const ctxSizeK = Math.round(ctxWindowSize / 1000);
    const curUsage = input.context_window?.current_usage;
    const inputTokens = curUsage?.input_tokens || 0;
    const cacheRead = curUsage?.cache_read_input_tokens || 0;
    const cacheWrite = curUsage?.cache_creation_input_tokens || 0;
    const usedTokensK = Math.round((inputTokens + cacheRead + cacheWrite) / 1000);
    const cwd = input.workspace?.current_dir || '';
    const dirName = cwd.split(/[/\\]/).filter(Boolean).pop() || '';
    const durationMs = input.cost?.total_duration_ms || 0;
    const mins = Math.floor(durationMs / 60000);
    const secs = Math.floor((durationMs % 60000) / 1000);
    const linesAdded = input.cost?.total_lines_added || 0;
    const linesRemoved = input.cost?.total_lines_removed || 0;
    const exceeds200k = input.exceeds_200k_tokens || false;

    // Cache hit ratio
    const totalCacheTokens = cacheRead + cacheWrite;
    const cacheHitPct = totalCacheTokens > 0 ? Math.round(cacheRead / totalCacheTokens * 100) : 0;

    // Estimated turns remaining (standalone: derive from context usage)
    const tokensPerTurn = inputTokens > 0 && input.cost?.total_turns > 0
      ? Math.round(inputTokens / input.cost.total_turns)
      : 0;
    const remainingTokens = ctxWindowSize - (inputTokens + cacheRead + cacheWrite);
    const estTurnsLeft = tokensPerTurn > 0 ? Math.floor(remainingTokens / tokensPerTurn) : 0;

    // Git branch (skip if no cwd or non-git dir, 500ms timeout)
    let branch = '';
    if (cwd) {
      try {
        const fs = await import('fs');
        // Quick check: walk up to find .git before spawning a process
        let checkDir = cwd;
        let isGit = false;
        for (let i = 0; i < 10; i++) {
          try { fs.accessSync(checkDir + '/.git'); isGit = true; break; } catch {}
          const parent = checkDir.replace(/[/\\][^/\\]+$/, '');
          if (parent === checkDir) break;
          checkDir = parent;
        }
        if (isGit) {
          const { execSync } = await import('child_process');
          branch = execSync('git branch --show-current 2>/dev/null', {
            cwd, timeout: 500, encoding: 'utf-8'
          }).trim();
        }
      } catch {}
    }

    // Worktree indicator
    const worktree = input.worktree?.name || '';

    // -- ANSI palette --
    const RST = '\x1b[0m';
    const BOLD = '\x1b[1m';
    const DIM = '\x1b[2m';
    const CYAN = '\x1b[36m';
    const GREEN = '\x1b[32m';
    const YELLOW = '\x1b[33m';
    const RED = '\x1b[31m';
    const MAGENTA = '\x1b[35m';
    const WHITE = '\x1b[37m';
    const BLUE = '\x1b[34m';

    // -- Context bar: 25 chars, tri-color zones --
    const barWidth = 25;
    const filled = Math.round(ctxPct * barWidth / 100);
    const greenZone = Math.round(barWidth * 0.7);
    const yellowZone = Math.round(barWidth * 0.9);
    let bar = '';
    for (let i = 0; i < barWidth; i++) {
      if (i < filled) {
        const color = i < greenZone ? GREEN : i < yellowZone ? YELLOW : RED;
        bar += `${color}━${RST}`;
      } else {
        bar += `${DIM}─${RST}`;
      }
    }
    const ctxColor = ctxPct >= 90 ? RED : ctxPct >= 70 ? YELLOW : GREEN;
    const ctxWarn = ctxPct >= 90 ? `${RED}!!${RST} ` : ctxPct >= 70 ? `${YELLOW}! ${RST} ` : '   ';

    // -- Line 1: Model | Cost | Duration | Git | Dir | Lines --
    let line1 = `${BOLD}${CYAN}${model}${RST}`;
    line1 += ` ${DIM}|${RST} ${GREEN}$${cost}${RST}`;
    line1 += ` ${DIM}|${RST} ${DIM}${mins}m${secs}s${RST}`;
    if (branch) line1 += ` ${DIM}|${RST} ${MAGENTA}${branch}${RST}`;
    if (worktree) line1 += ` ${DIM}[wt:${worktree}]${RST}`;
    if (dirName) line1 += ` ${DIM}|${RST} ${WHITE}${dirName}${RST}`;
    if (linesAdded || linesRemoved) line1 += ` ${GREEN}+${linesAdded}${RST}${RED}-${linesRemoved}${RST}`;
    process.stdout.write(line1 + '\n');

    // -- Line 2: Context bar + tokens + est turns + cache --
    let line2 = `${ctxWarn}${bar} ${ctxColor}${BOLD}${ctxPct}%${RST}`;
    line2 += ` ${DIM}${usedTokensK}K/${ctxSizeK}K${RST}`;
    if (estTurnsLeft > 0) {
      const turnsColor = estTurnsLeft <= 3 ? RED : estTurnsLeft <= 8 ? YELLOW : GREEN;
      line2 += ` ${DIM}|${RST} ${turnsColor}~${estTurnsLeft} turns left${RST}`;
    }
    if (cacheHitPct > 0) line2 += ` ${DIM}| cache ${cacheHitPct}%${RST}`;
    if (exceeds200k) line2 += ` ${RED}${BOLD}[EXT]${RST}`;
    process.stdout.write(line2 + '\n');

  } catch {
    process.stdout.write('Claude Code\n');
  }
})();

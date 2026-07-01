/**
 * Environment detection and tool-selection rules for Claude Code hooks.
 *
 * Detects: Git Bash, PowerShell, cmd, WSL, Desktop, CLI, VS Code
 * Exports: detectEnv(), getToolSuggestion(), ALLOWLIST, DANGEROUS
 */

// ─── Environment Detection ───────────────────────────────────────────────────

/**
 * Detect the current execution environment from env vars and stdin JSON.
 * @param {object} [stdinData] - Parsed stdin JSON from hook event
 * @returns {{ shell: string, entrypoint: string, isWSL: boolean, isDesktop: boolean, hasDC: boolean }}
 */
export function detectEnv(stdinData = {}) {
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT || '';
  const shell = detectShell();
  const isWSL = !!(process.env.WSL_DISTRO_NAME);
  const isDesktop = entrypoint === 'claude-desktop';
  // Desktop Commander available = Desktop app or explicitly configured
  const hasDC = isDesktop || entrypoint === '';

  return { shell, entrypoint, isWSL, isDesktop, hasDC };
}

function detectShell() {
  // Check SHELL env var (Unix/Git Bash)
  const shellEnv = process.env.SHELL || '';
  if (shellEnv.includes('bash') || shellEnv.includes('zsh') || shellEnv.includes('fish')) {
    return 'bash';
  }
  // Check PSModulePath (PowerShell sets this)
  if (process.env.PSModulePath) {
    return 'powershell';
  }
  // Check COMSPEC (Windows cmd)
  const comspec = (process.env.COMSPEC || '').toLowerCase();
  if (comspec.includes('cmd.exe')) {
    return 'cmd';
  }
  // Default on Windows = bash (Git Bash is common in Claude Code)
  if (process.platform === 'win32') {
    return 'bash';
  }
  return 'bash';
}

// ─── Allowlist ───────────────────────────────────────────────────────────────

/** Commands that are ALWAYS allowed, regardless of environment. */
export const ALLOWLIST = new Set([
  // Version control
  'git', 'gh', 'svn', 'hg',
  // Package managers (all platforms)
  'npm', 'npx', 'yarn', 'pnpm', 'bun', 'deno',
  'pip', 'pip3', 'uv', 'uvx', 'pipx', 'conda',
  'cargo', 'rustup', 'go',
  'gem', 'bundle', 'rbenv',
  'brew', 'apt', 'apt-get', 'dnf', 'yum', 'pacman', 'apk', 'zypper', 'nix', 'snap', 'port',
  'choco', 'winget', 'scoop',
  // Runtimes
  'node', 'python', 'python3', 'py', 'ruby', 'java', 'javac', 'dotnet', 'php', 'perl', 'lua',
  // Build tools
  'make', 'cmake', 'gradle', 'mvn', 'msbuild', 'ninja',
  // Docker / containers
  'docker', 'docker-compose', 'podman', 'nerdctl',
  // Cloud / infra
  'terraform', 'kubectl', 'helm', 'aws', 'az', 'gcloud', 'fly', 'vercel', 'netlify', 'railway',
  // Network
  'curl', 'wget', 'ssh', 'scp', 'rsync', 'nc', 'ncat',
  // Archive
  'tar', 'zip', 'unzip', 'gzip', 'gunzip', 'bzip2', '7z',
  // File ops (safe)
  'chmod', 'chown', 'mkdir', 'rmdir', 'cp', 'mv', 'ln', 'touch', 'rm',
  // Info / navigation
  'which', 'where', 'where.exe', 'whoami', 'hostname', 'uname', 'env', 'printenv',
  'export', 'source', 'cd', 'pwd', 'ls', 'dir', 'tree',
  // Process
  'kill', 'pkill', 'ps', 'top', 'htop', 'lsof',
  // Data processing (pipe-friendly)
  'jq', 'yq', 'sort', 'uniq', 'wc', 'diff', 'patch', 'tee', 'xargs', 'tr', 'cut', 'paste',
  'du', 'df', 'free', 'file', 'stat', 'readlink', 'realpath', 'basename', 'dirname',
  // Database CLIs
  'psql', 'mysql', 'sqlite3', 'mongosh', 'redis-cli',
  // Media / conversion
  'ffmpeg', 'magick', 'convert', 'pdftotext',
  // Crypto / security
  'openssl', 'certbot', 'gpg', 'ssh-keygen',
  // System (Windows)
  'reg', 'net', 'sc', 'icacls', 'wmic', 'msiexec', 'certutil',
  // Testing
  'jest', 'pytest', 'mocha', 'vitest', 'playwright',
  // Misc dev
  'code', 'subl', 'vim', 'nano', 'less', 'more', 'man',
  'base64', 'md5sum', 'sha256sum', 'xxd', 'strings', 'nm', 'objdump',
  'strace', 'ltrace', 'time', 'timeout', 'watch', 'nohup', 'screen', 'tmux',
  // Shell builtins that are always fine
  'echo', 'printf', 'test', 'true', 'false', 'set', 'unset', 'alias', 'type', 'command',
  'read', 'wait', 'trap', 'exec', 'eval', 'shift', 'return', 'exit',
  // Claude tools
  'claude', 'rh-telemetry',
]);

// ─── Dangerous Patterns (always BLOCK) ───────────────────────────────────────

/**
 * True when an rm target token IS the filesystem root, a bare drive root, or
 * a home directory itself — as opposed to a file/dir somewhere under them.
 * The previous regex fired on ANY argument starting with `/` (so
 * `rm /c/Users/x/Temp/file.zip` was blocked — observed false positives
 * 2026-06-12); this checks the resolved target, not its first character.
 */
function isRmTargetRootOrHome(token) {
  let t = token.replace(/^["']|["']$/g, ''); // strip quotes
  if (/^[\\/]+\*?$/.test(t)) return true; // "/", "//", "/*"
  t = t.replace(/\\/g, '/');
  t = t.replace(/\/\*$/, ''); // "X/*" → treat as X (rm -rf home/* empties home)
  t = t.replace(/\/+$/, ''); // trailing slashes
  if (/^(~|\$HOME|%USERPROFILE%)$/i.test(t)) return true; // home aliases
  if (/^\/[a-z]$/i.test(t)) return true; // bare drive: /c
  if (/^[a-z]:$/i.test(t)) return true; // bare drive: C:
  if (/^(?:[a-z]:|\/[a-z])?\/(?:Users|home)\/[^/]+$/i.test(t)) return true; // home dir itself
  return false;
}

/** Patterns that are genuinely dangerous — hard exit 2 block. */
export const DANGEROUS_PATTERNS = [
  {
    test: (cmd) => {
      // Match rm at the start of the command, after a shell separator
      // (; & |), after a NEWLINE (multiline flag — a multi-line bash block put
      // `rm -rf /` on its own line and evaded the old single-line ^ anchor), or
      // after `find … -exec`. Scan every line for an rm target.
      for (const m of cmd.matchAll(/(?:^|[;&|\n]\s*|-exec\s+)rm\s+(.+)$/gim)) {
        const hit = m[1]
          .split(/\s+/)
          .filter((tok) => tok && !tok.startsWith('-'))
          .some(isRmTargetRootOrHome);
        if (hit) return true;
      }
      return false;
    },
    message: 'BLOCKED: rm targeting the filesystem root, a drive root, or a home directory is extremely dangerous.',
  },
  {
    // Block redirecting (> or >>) into .claude/settings.json under ANY path
    // form — ~, $HOME, %USERPROFILE%, an absolute path, or relative — and either
    // path separator. The old regex only caught the literal `> ~/.claude/...`.
    test: (cmd) => />>?\s*[^\s>|&;]*\.claude[\\/]settings\.json\b/i.test(cmd),
    message: 'BLOCKED: Direct write to .claude/settings.json — use setup-hooks.js instead.',
  },
  {
    test: (cmd) => /chmod\s+777\s+\//.test(cmd),
    message: 'BLOCKED: chmod 777 on root paths is a security risk.',
  },
  {
    test: (cmd) => /mkfs|dd\s+if=.*of=\/dev/.test(cmd),
    message: 'BLOCKED: Filesystem-destructive command.',
  },
];

// ─── Wrong-Tool Suggestions ──────────────────────────────────────────────────

/**
 * Check if a command should suggest a better tool for the environment.
 * Returns null if the command is fine, or a suggestion string if not.
 *
 * @param {string} cmdName - Base command name (e.g., 'cat', 'grep')
 * @param {string} fullCmd - Full command string
 * @param {{ shell: string, entrypoint: string, hasDC: boolean }} env
 * @returns {string|null} Suggestion text for contextAddition, or null
 */
export function getToolSuggestion(cmdName, fullCmd, env) {
  const lower = cmdName.toLowerCase();

  // ── Dedicated tool replacements (all environments) ──

  if (lower === 'cat') {
    // OK for heredocs, /dev/null, pipes (cat file | ...), concatenation (multiple files after cat)
    if (fullCmd.includes('<<') || fullCmd.includes('/dev/null') || fullCmd.includes('|')) return null;
    return 'Use the Read tool instead of `cat` for reading file contents. It supports offset/limit for partial reads.';
  }

  if (lower === 'head') {
    return 'Use the Read tool with `limit` parameter instead of `head`. Example: Read(file, limit=10).';
  }

  if (lower === 'tail') {
    if (fullCmd.includes('-f') || fullCmd.includes('--follow')) return null; // tail -f is legit
    return 'Use the Read tool with `offset` (negative for tail) instead of `tail`.';
  }

  if (/^(grep|egrep|fgrep|rg|ripgrep)$/.test(lower)) {
    return 'Use the Grep tool for content search — it has built-in context, glob filters, and output modes.';
  }

  if (lower === 'find') {
    if (fullCmd.includes('-exec') || fullCmd.includes('-delete')) return null; // find with actions
    return 'Use the Glob tool for file search — it supports patterns like "**/*.js" and is much faster.';
  }

  if (lower === 'sed') {
    if (fullCmd.includes('-i')) {
      return 'Use the Edit tool instead of `sed -i` for in-place file editing.';
    }
    // sed in pipes for stream processing is fine
    if (fullCmd.includes('|')) return null;
    return 'Use the Edit tool instead of `sed` for file editing. Sed is fine in pipes for data processing.';
  }

  if (lower === 'awk') {
    if (fullCmd.includes('|')) return null; // awk in pipes is legitimate
    return 'Use the Edit tool instead of `awk` for file editing. Awk is fine in pipes for data processing.';
  }

  // echo/printf with file redirect (not in pipe)
  if (/^(echo|printf)$/.test(lower)) {
    if (fullCmd.includes('>') && !fullCmd.includes('|')) {
      return 'Use the Write tool instead of echo/printf with file redirect (>).';
    }
    return null;
  }

  // ── PowerShell cmdlets in non-PowerShell environments ──

  if (lower === 'get-childitem' || lower === 'gci') {
    if (env.shell === 'powershell') return null; // Native PS environment
    return "You're in Git Bash. Use `ls` or the Glob tool instead of PowerShell cmdlets. If you need PowerShell, wrap with: powershell.exe -Command '...'";
  }

  if (lower === 'get-content' || lower === 'gc') {
    return 'Use the Read tool instead of Get-Content for reading files.';
  }

  if (lower === 'select-string' || lower === 'sls') {
    return 'Use the Grep tool instead of Select-String for content search.';
  }

  if (lower === 'get-process' || lower === 'gps') {
    if (env.shell === 'powershell') return null;
    return "You're in Git Bash. Use `ps` instead of Get-Process, or wrap with: powershell.exe -Command '...'";
  }

  if (lower === 'set-content' || lower === 'out-file') {
    return 'Use the Write tool instead of Set-Content/Out-File for writing files.';
  }

  // ── cmd.exe commands in bash ──

  if (lower === 'findstr') {
    return 'Use the Grep tool instead of `findstr` for content search.';
  }

  // `dir /s /b` style — suggest Glob
  if (lower === 'dir' && env.shell === 'bash') {
    if (fullCmd.includes('/s') || fullCmd.includes('/b')) {
      return 'Use the Glob tool instead of `dir /s /b` for recursive file search.';
    }
    // plain `dir` in bash → suggest ls
    return 'Use `ls` or the Glob tool instead of `dir` in Git Bash.';
  }

  // `type` command (cmd equivalent of cat)
  if (lower === 'type' && env.shell === 'bash') {
    // `type` in bash is a shell builtin (shows command location), only suggest for Windows-style usage
    if (fullCmd.includes('"') || fullCmd.includes('\\')) {
      return 'Use the Read tool instead of `type` for reading file contents.';
    }
  }

  return null;
}
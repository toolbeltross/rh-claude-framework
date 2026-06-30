# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project is
pre-1.0 and not yet published to npm, so changes accumulate under *Unreleased*.

## [Unreleased]

### Security
- **Telemetry server binds to loopback by default.** `server.listen` had no host
  argument and bound all interfaces (`0.0.0.0`/`::`), exposing session
  prompts/costs/transcripts and the unauthenticated write endpoints to the LAN.
  Now binds `127.0.0.1`; opt in to LAN access with `RH_TELEMETRY_HOST=0.0.0.0`.
- **`db-init` no longer accepts `--superuser-password`.** The Postgres superuser
  password could be passed on the command line (world-visible via `ps` /
  Task Manager). It now comes only from `PGPASSWORD`.
- **Closed dangerous-command guard evasions.** The `rm -rf /` block missed
  newline-separated (`echo hi\nrm -rf /`) and `find -exec rm` forms; the
  `settings.json` write-block matched only the literal `~/…` path. Both broadened.

### Fixed
- **No more silent config data-loss.** A malformed `settings.json` was silently
  replaced with a framework-only file, discarding the user's model/permissions/
  env. `init` now takes a timestamped backup and aborts with guidance instead.
  All config writers (`settings.json`, `oversight.json`, `.pgpass`) use atomic
  temp-then-rename writes so an interrupted write can't truncate them.
- **read-audit works off-Windows.** It built its log path from `USERPROFILE`
  only, writing to a literal `undefined/.claude/…` dir on macOS/Linux and
  silently disabling the read-integrity truncation audit. Now resolves via
  `@rh/shared/config`.
- **Hardcoded maintainer paths removed.** `rh-learning-loop.js` and
  `rh-oversight-health.js` assembled the maintainer's personal paths from split
  `path.join` args, evading the zero-hardcoded-paths regression test; the test
  now catches that form.
- **auto-prune locks its scribe rewrites.** It rewrote the canonical
  `cleanup.md`/`recommendations.md`/`learnings.md` without a lock, racing the
  scribe writers; now wrapped in `withLock`.
- **Atomic `settings.json` writes in telemetry** `setup-hooks` and
  `repair-statusline`.

### Added
- **`@rh/shared/fs-atomic.js`** (`writeFileAtomic`) — temp-file + rename, used by
  every config writer.
- **CI** — `.github/workflows/ci.yml` runs the full test suite + an outer-seam
  install/self-test on Ubuntu and Windows (Node 20/22) for every push and PR.
- **Community files** — `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, this changelog.

### Changed
- Documentation counts corrected (tests 495, 20 agents, 18 rules) and dead
  `SESSION_STATE.md`/`PLAN-*.md` references removed from `CLAUDE.md`.

---

## Prior history

Earlier work — the 5-package monorepo reorg, the telemetry dashboard, the
oversight enforcement layer, and the initial public release — predates this
changelog. See the git history (`git log`) and `CLAUDE.md` for that lineage.

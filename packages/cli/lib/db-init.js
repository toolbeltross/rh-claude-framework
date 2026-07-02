// db-init.js — one-shot bootstrap of the local Postgres FTS shadow.
//
// Reproduces what previously had to be done by hand to enable scribeDb/contextDb:
//   1. create the rh_scribe ROLE (with a generated password) + DATABASE  [needs superuser]
//   2. write the pgpass entry so the deployed scripts' `-w` (never-prompt) connection works
//   3. load sql/rh_scribe_schema.sql + rh_context_schema.sql + sql/migrations/*.sql
//   4. set scribeDb:true + contextDb:true in oversight.json
//   5. verify: write+read+delete a probe row through psql
//
// md/jsonl remain canonical throughout; the DB is a best-effort shadow.
// Idempotent: safe to re-run. No npm deps — shells out to psql (like scribe-db.js).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const PKG_ROOT = path.join(__dirname, '..');
const PACKAGES_ROOT = path.join(PKG_ROOT, '..');
const REPO_ROOT = path.join(PACKAGES_ROOT, '..');
const SHARED_PKG = path.join(PACKAGES_ROOT, 'shared');
const SQL_DIR = path.join(REPO_ROOT, 'sql');
const { writeFileAtomic } = require(path.join(SHARED_PKG, 'fs-atomic'));

// Static probe list: Windows installer dirs + common POSIX locations. findPsql()
// additionally globs versioned install dirs (Postgres.app, /usr/lib/postgresql).
const PSQL_PROBES = [
  'C:/Program Files/PostgreSQL/18/bin/psql.exe',
  'C:/Program Files/PostgreSQL/17/bin/psql.exe',
  'C:/Program Files/PostgreSQL/16/bin/psql.exe',
  '/opt/homebrew/bin/psql',   // macOS Homebrew (Apple Silicon)
  '/usr/local/bin/psql',      // macOS Homebrew (Intel) / common
  '/opt/local/bin/psql',      // MacPorts
  '/usr/bin/psql',            // Linux distro default
];

// ---- pure helpers (unit-tested) -------------------------------------------

/** Postgres identifiers we interpolate into DDL must be plain idents (no injection). */
function validateIdent(name, what) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`invalid ${what || 'identifier'}: ${JSON.stringify(name)} (expected [A-Za-z_][A-Za-z0-9_]*)`);
  }
  return name;
}

function genPassword() {
  return crypto.randomBytes(18).toString('base64url'); // ~24 url-safe chars, no quoting hazards
}

/** Idempotent role bootstrap: create if absent, else reset password to the known value. */
function buildRoleSql(role, password) {
  validateIdent(role, 'role');
  const lit = "'" + String(password).replace(/'/g, "''") + "'";
  return `DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='${role}') THEN
    CREATE ROLE ${role} LOGIN PASSWORD ${lit};
  ELSE
    ALTER ROLE ${role} LOGIN PASSWORD ${lit};
  END IF;
END $$;`;
}

/** One libpq pgpass line: host:port:database:user:password (the standard format). */
function pgpassLine(host, port, db, user, password) {
  return `${host}:${port}:${db}:${user}:${password}`;
}

/** Default pgpass location per platform. */
function pgpassPath() {
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA || path.join(process.env.USERPROFILE || process.env.HOME || '', 'AppData', 'Roaming');
    return path.join(appdata, 'postgresql', 'pgpass.conf');
  }
  return path.join(process.env.HOME || '', '.pgpass');
}

/** Password from an existing pgpass line matching `prefix` (host:port:db:user:),
 * or null. Lets a re-run REUSE the role's current password instead of rotating
 * it — a rotation would invalidate any OTHER pgpass line for the same role. */
function readPgpassPassword(ppath, prefix) {
  try {
    for (const l of fs.readFileSync(ppath, 'utf8').split(/\r?\n/)) {
      if (l.startsWith(prefix)) return l.slice(prefix.length);
    }
  } catch {}
  return null;
}

/** Schema files to apply, in order: base schemas then migrations (sorted). */
function schemaFiles(sqlDir = SQL_DIR) {
  const base = ['rh_scribe_schema.sql', 'rh_context_schema.sql'].map(f => path.join(sqlDir, f));
  const migDir = path.join(sqlDir, 'migrations');
  let migs = [];
  try { migs = fs.readdirSync(migDir).filter(f => f.endsWith('.sql')).sort().map(f => path.join(migDir, f)); } catch {}
  return [...base, ...migs];
}

function parseArgs(argv) {
  const o = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--superuser') o.superuser = argv[++i];
    else if (a === '--db-name') o.dbName = argv[++i];
    else if (a === '--db-user') o.dbUser = argv[++i];
    else if (a === '--host') o.host = argv[++i];
    else if (a === '--port') o.port = parseInt(argv[++i], 10);
    else if (a === '--psql') o.psql = argv[++i];
    else if (a === '--password') o.password = argv[++i]; // role password (else generated)
  }
  return o;
}

// ---- psql plumbing ---------------------------------------------------------

function findPsql(explicit) {
  if (explicit) return explicit;
  for (const p of PSQL_PROBES) { try { fs.accessSync(p); return p; } catch {} }
  // Glob versioned install dirs: Postgres.app (macOS) + Linux packages, newest first.
  for (const base of ['/Applications/Postgres.app/Contents/Versions', '/usr/lib/postgresql']) {
    let vers = [];
    try { vers = fs.readdirSync(base).sort().reverse(); } catch {}
    for (const v of vers) {
      const p = `${base}/${v}/bin/psql`;
      try { fs.accessSync(p); return p; } catch {}
    }
  }
  return 'psql'; // rely on PATH
}

/** Run SQL (string) or a file (-f) against a db as `user`, auth via PGPASSWORD. */
function psqlExec({ psql, user, host, port, db, password, sql, file, timeoutMs = 30000 }) {
  const args = ['-U', user, '-h', host, '-p', String(port), '-d', db, '-w', '-v', 'ON_ERROR_STOP=1'];
  if (file) args.push('-f', file);
  else args.push('-t', '-A', '-f', '-');
  const res = spawnSync(psql, args, {
    timeout: timeoutMs, encoding: 'utf8', windowsHide: true,
    input: file ? undefined : Buffer.from(sql || '', 'utf8'),
    env: { ...process.env, PGCLIENTENCODING: 'UTF8', PGPASSWORD: password, PGCONNECT_TIMEOUT: '8' },
  });
  if (res.error) return { ok: false, error: String(res.error.message || res.error) };
  if (res.status !== 0) return { ok: false, error: (res.stderr || '').slice(0, 500) };
  return { ok: true, stdout: (res.stdout || '').trim() };
}

// ---- orchestration ---------------------------------------------------------

function run(argv = process.argv.slice(3)) {
  const { config, writeConfig } = require(path.join(SHARED_PKG, 'config'));
  const c = config;
  const o = parseArgs(argv);

  const role = validateIdent(o.dbUser || c.scribeDbUser, 'db-user');
  const db = validateIdent(o.dbName || c.scribeDbName, 'db-name');
  const host = o.host || c.scribeDbHost;
  const port = o.port || c.scribeDbPort;
  const psql = findPsql(o.psql || c.scribeDbPsql);
  const superuser = o.superuser || 'postgres';
  const ppath = pgpassPath();
  const pgpassPrefix = `${host}:${port}:${db}:${role}:`;
  // Password priority: explicit --password > the one already in pgpass for this
  // exact target (reuse → the ALTER ROLE is a no-op → OTHER pgpass lines for this
  // role stay valid) > a freshly generated one (first-time setup).
  const password = o.password || readPgpassPassword(ppath, pgpassPrefix) || genPassword();
  const pline = pgpassLine(host, port, db, role, password);

  const log = (m) => console.log(m);
  log(`rh-oversight db-init`);
  log(`────────────────────────────────────────`);
  log(`  target:   ${role}@${host}:${port}/${db}`);
  log(`  psql:     ${psql}`);
  log(`  pgpass:   ${ppath}`);

  // Superuser password comes ONLY from PGPASSWORD — never a CLI flag, since
  // process arguments are world-visible (ps, /proc/<pid>/cmdline, Task Manager).
  const superPw = process.env.PGPASSWORD || null;

  if (o.dryRun) {
    log(`\n  [dry-run] would:`);
    log(`   1. ensure role ${role} + database ${db} (as ${superuser})`);
    log(`   2. write pgpass line: ${host}:${port}:${db}:${role}:********`);
    log(`   3. load: ${schemaFiles().map(f => path.basename(f)).join(', ')}`);
    log(`   4. verify a scribe probe round-trips + the context schema is present`);
    log(`   5. set scribeDb/contextDb in oversight.json (only what verified)`);
    return 0;
  }

  if (!superPw) {
    log(`\n  Superuser credentials required to create the role/database (one time).`);
    log(`  Re-run with PGPASSWORD set, e.g.:`);
    log(`     PGPASSWORD=<postgres-pw> rh-oversight db-init`);
    log(`\n  …or run these once as a superuser yourself, then re-run db-init:`);
    log(`     ${buildRoleSql(role, '<choose-a-password>').replace(/\n/g, '\n     ')}`);
    log(`     CREATE DATABASE ${db} OWNER ${role};`);
    log(`  and add to ${ppath}:`);
    log(`     ${host}:${port}:${db}:${role}:<that-password>`);
    return 2;
  }

  // 1) ensure role + database (as superuser, against the maintenance db `postgres`)
  log(`\n  [1/5] ensuring role + database…`);
  let r = psqlExec({ psql, user: superuser, host, port, db: 'postgres', password: superPw, sql: buildRoleSql(role, password) });
  if (!r.ok) { console.error(`  ✗ role bootstrap failed: ${r.error}`); return 1; }
  const existsRes = psqlExec({ psql, user: superuser, host, port, db: 'postgres', password: superPw, sql: `SELECT 1 FROM pg_database WHERE datname='${db}';` });
  if (!existsRes.ok) { console.error(`  ✗ db existence check failed: ${existsRes.error}`); return 1; }
  if (existsRes.stdout !== '1') {
    r = psqlExec({ psql, user: superuser, host, port, db: 'postgres', password: superPw, sql: `CREATE DATABASE ${db} OWNER ${role};` });
    if (!r.ok) {
      // Tolerate a concurrent / pre-existing create — the check-then-create above
      // has a TOCTOU window, and CREATE DATABASE cannot run in a txn to close it.
      if (/already exists|duplicate_database|42P04/i.test(r.error || '')) {
        log(`        database ${db} already exists`);
      } else {
        console.error(`  ✗ CREATE DATABASE failed: ${r.error}`); return 1;
      }
    } else {
      log(`        created database ${db}`);
    }
  } else {
    log(`        database ${db} already exists`);
  }

  // 2) write pgpass (idempotent: replace any existing line for this host:port:db:user)
  log(`  [2/5] writing pgpass…`);
  try {
    fs.mkdirSync(path.dirname(ppath), { recursive: true });
    let lines = [];
    if (fs.existsSync(ppath)) lines = fs.readFileSync(ppath, 'utf8').split(/\r?\n/).filter(Boolean).filter(l => !l.startsWith(pgpassPrefix));
    lines.push(pline);
    writeFileAtomic(ppath, lines.join('\n') + '\n', process.platform !== 'win32' ? { mode: 0o600 } : {});
    if (process.platform !== 'win32') { try { fs.chmodSync(ppath, 0o600); } catch {} }
  } catch (e) { console.error(`  ✗ pgpass write failed: ${e.message}`); return 1; }

  // 3) load schema (as the role, into its db — uses the password we just set)
  log(`  [3/5] loading schema…`);
  for (const f of schemaFiles()) {
    if (!fs.existsSync(f)) { console.error(`  ✗ schema file missing: ${f}`); return 1; }
    const sr = psqlExec({ psql, user: role, host, port, db, password, file: f });
    if (!sr.ok) { console.error(`  ✗ failed applying ${path.basename(f)}: ${sr.error}`); return 1; }
    log(`        applied ${path.basename(f)}`);
  }

  // 4) verify BEFORE advertising: a scribe row must round-trip, and the context
  //    schema's core table must exist. Flags are flipped only AFTER this passes,
  //    so a failed shadow never leaves oversight.json claiming a working one.
  log(`  [4/5] verifying the shadow…`);
  const marker = 'db-init-probe-' + crypto.randomBytes(4).toString('hex');
  const ins = psqlExec({ psql, user: role, host, port, db, password,
    sql: `INSERT INTO scribe_rows (bucket,row_id,content,source_file) VALUES ('learnings','${marker}','db-init probe (auto-deleted)','db-init-verification');` });
  if (!ins.ok) { console.error(`  ✗ probe insert failed: ${ins.error}`); return 1; }
  const sel = psqlExec({ psql, user: role, host, port, db, password,
    sql: `SELECT count(*) FROM scribe_rows WHERE row_id='${marker}';` });
  // Scope cleanup to THIS marker (not a blanket source_file delete) and check it.
  const del = psqlExec({ psql, user: role, host, port, db, password,
    sql: `DELETE FROM scribe_rows WHERE row_id='${marker}';` });
  if (!del.ok) console.error(`  ! probe-row cleanup failed — leftover row_id=${marker}: ${del.error}`);
  if (!sel.ok || sel.stdout !== '1') { console.error(`  ✗ scribe probe did not round-trip (got ${JSON.stringify(sel.stdout)})`); return 1; }
  // Context schema: confirm a core table actually exists (step 3 checked the file
  // applied; this confirms the table before we advertise contextDb).
  const ctx = psqlExec({ psql, user: role, host, port, db, password,
    sql: `SELECT to_regclass('public.ctx_session') IS NOT NULL;` });
  const contextOk = ctx.ok && ctx.stdout === 't';
  if (!contextOk) console.error(`  ! context schema check failed (ctx_session missing) — leaving contextDb OFF`);

  // 5) flip only the flags that actually verified.
  log(`  [5/5] enabling verified flags in oversight.json…`);
  writeConfig({ scribeDb: true, contextDb: contextOk, scribeDbName: db, scribeDbUser: role, scribeDbHost: host, scribeDbPort: port });

  log(`\n  ✓ Postgres FTS shadow is ready. scribeDb=ON, contextDb=${contextOk ? 'ON' : 'OFF'}.`);
  log(`    Next: 'rh-oversight ingest-logs --full' to backfill log history into FTS.`);
  return 0;
}

module.exports = { run, buildRoleSql, pgpassLine, pgpassPath, readPgpassPassword, schemaFiles, findPsql, parseArgs, validateIdent, genPassword };

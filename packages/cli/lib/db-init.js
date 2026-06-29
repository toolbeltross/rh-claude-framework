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

const PSQL_PROBES = [
  'C:/Program Files/PostgreSQL/18/bin/psql.exe',
  'C:/Program Files/PostgreSQL/17/bin/psql.exe',
  'C:/Program Files/PostgreSQL/16/bin/psql.exe',
  '/usr/bin/psql', '/usr/local/bin/psql',
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
    else if (a === '--superuser-password') o.superuserPassword = argv[++i];
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
  const password = o.password || genPassword();
  const ppath = pgpassPath();
  const pline = pgpassLine(host, port, db, role, password);

  const log = (m) => console.log(m);
  log(`rh-oversight db-init`);
  log(`────────────────────────────────────────`);
  log(`  target:   ${role}@${host}:${port}/${db}`);
  log(`  psql:     ${psql}`);
  log(`  pgpass:   ${ppath}`);

  const superPw = o.superuserPassword || process.env.PGPASSWORD || null;

  if (o.dryRun) {
    log(`\n  [dry-run] would:`);
    log(`   1. ensure role ${role} + database ${db} (as ${superuser})`);
    log(`   2. write pgpass line: ${host}:${port}:${db}:${role}:********`);
    log(`   3. load: ${schemaFiles().map(f => path.basename(f)).join(', ')}`);
    log(`   4. set scribeDb:true + contextDb:true in oversight.json`);
    log(`   5. verify a probe row round-trips`);
    return 0;
  }

  if (!superPw) {
    log(`\n  Superuser credentials required to create the role/database (one time).`);
    log(`  Re-run with PGPASSWORD set (or --superuser-password <pw>), e.g.:`);
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
    if (!r.ok) { console.error(`  ✗ CREATE DATABASE failed: ${r.error}`); return 1; }
    log(`        created database ${db}`);
  } else {
    log(`        database ${db} already exists`);
  }

  // 2) write pgpass (idempotent: replace any existing line for this host:port:db:user)
  log(`  [2/5] writing pgpass…`);
  try {
    fs.mkdirSync(path.dirname(ppath), { recursive: true });
    const prefix = `${host}:${port}:${db}:${role}:`;
    let lines = [];
    if (fs.existsSync(ppath)) lines = fs.readFileSync(ppath, 'utf8').split(/\r?\n/).filter(Boolean).filter(l => !l.startsWith(prefix));
    lines.push(pline);
    fs.writeFileSync(ppath, lines.join('\n') + '\n', 'utf8');
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

  // 4) flip the flags in oversight.json
  log(`  [4/5] enabling scribeDb + contextDb in oversight.json…`);
  writeConfig({ scribeDb: true, contextDb: true, scribeDbName: db, scribeDbUser: role, scribeDbHost: host, scribeDbPort: port });

  // 5) verify a probe row round-trips through scribe_rows
  log(`  [5/5] verifying a probe row round-trips…`);
  const marker = 'db-init-probe-' + crypto.randomBytes(4).toString('hex');
  const ins = psqlExec({ psql, user: role, host, port, db, password,
    sql: `INSERT INTO scribe_rows (bucket,row_id,content,source_file) VALUES ('learnings','${marker}','db-init probe (auto-deleted)','db-init-verification');` });
  if (!ins.ok) { console.error(`  ✗ probe insert failed: ${ins.error}`); return 1; }
  const sel = psqlExec({ psql, user: role, host, port, db, password,
    sql: `SELECT count(*) FROM scribe_rows WHERE row_id='${marker}';` });
  psqlExec({ psql, user: role, host, port, db, password, sql: `DELETE FROM scribe_rows WHERE source_file='db-init-verification';` });
  if (!sel.ok || sel.stdout !== '1') { console.error(`  ✗ probe row did not round-trip (got ${JSON.stringify(sel.stdout)})`); return 1; }

  log(`\n  ✓ Postgres FTS shadow is ready. scribeDb + contextDb are ON.`);
  log(`    Next: 'rh-oversight ingest-logs --full' to backfill log history into FTS.`);
  return 0;
}

module.exports = { run, buildRoleSql, pgpassLine, pgpassPath, schemaFiles, parseArgs, validateIdent, genPassword };

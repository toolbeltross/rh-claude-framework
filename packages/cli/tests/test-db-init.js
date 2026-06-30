// Unit tests for lib/db-init.js pure helpers. The live bootstrap (psql role/db
// creation, schema load, verify) is exercised against a throwaway DB out of band.

const assert = require('assert');
const path = require('path');
const { buildRoleSql, pgpassLine, pgpassPath, schemaFiles, parseArgs, validateIdent, genPassword } = require('../lib/db-init');

const tests = [
  {
    name: 'validateIdent accepts plain idents, rejects injection',
    fn: () => {
      assert.strictEqual(validateIdent('rh_scribe', 'db'), 'rh_scribe');
      assert.strictEqual(validateIdent('_x9', 'db'), '_x9');
      for (const bad of ['rh-scribe', 'x; DROP DATABASE y', "a'b", '1abc', 'a b', '']) {
        assert.throws(() => validateIdent(bad, 'db'), /invalid db/, `should reject ${JSON.stringify(bad)}`);
      }
    },
  },
  {
    name: 'buildRoleSql is idempotent (create-or-alter) and escapes the password',
    fn: () => {
      const sql = buildRoleSql('rh_scribe', "p'w");
      assert.ok(sql.includes("IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='rh_scribe')"), 'guards on existence');
      assert.ok(/CREATE ROLE rh_scribe LOGIN PASSWORD/.test(sql), 'creates when absent');
      assert.ok(/ALTER ROLE rh_scribe LOGIN PASSWORD/.test(sql), 'alters when present');
      assert.ok(sql.includes("'p''w'"), `single-quote in password must be doubled; got: ${sql}`);
      assert.throws(() => buildRoleSql('bad;role', 'x'), /invalid role/);
    },
  },
  {
    name: 'pgpassLine is the standard libpq 5-field format',
    fn: () => {
      assert.strictEqual(pgpassLine('localhost', 5432, 'rh_scribe', 'rh_scribe', 'secret'),
        'localhost:5432:rh_scribe:rh_scribe:secret');
    },
  },
  {
    name: 'pgpassPath is platform-appropriate',
    fn: () => {
      const p = pgpassPath();
      if (process.platform === 'win32') assert.ok(/postgresql[\\/]pgpass\.conf$/.test(p), p);
      else assert.ok(p.endsWith('.pgpass'), p);
    },
  },
  {
    name: 'schemaFiles returns base schemas first, then sorted migrations',
    fn: () => {
      const files = schemaFiles().map(f => path.basename(f));
      assert.deepStrictEqual(files.slice(0, 2), ['rh_scribe_schema.sql', 'rh_context_schema.sql'], `base order wrong: ${files}`);
      const migs = files.slice(2);
      assert.ok(migs.length >= 1, 'expected at least one migration');
      assert.deepStrictEqual(migs, [...migs].sort(), 'migrations must be sorted');
      assert.ok(migs.every(f => f.endsWith('.sql')));
    },
  },
  {
    name: 'parseArgs parses the documented flags',
    fn: () => {
      const o = parseArgs(['--dry-run', '--superuser', 'pg', '--superuser-password', 's3', '--db-name', 'd', '--db-user', 'u', '--host', 'h', '--port', '6000', '--psql', '/x/psql']);
      assert.strictEqual(o.dryRun, true);
      assert.strictEqual(o.superuser, 'pg');
      // --superuser-password is intentionally NOT a flag (argv is world-visible);
      // the superuser password comes only from PGPASSWORD. The token is ignored.
      assert.strictEqual(o.superuserPassword, undefined);
      assert.strictEqual(o.dbName, 'd');
      assert.strictEqual(o.dbUser, 'u');
      assert.strictEqual(o.host, 'h');
      assert.strictEqual(o.port, 6000);
      assert.strictEqual(o.psql, '/x/psql');
    },
  },
  {
    name: 'genPassword is url-safe and non-trivial',
    fn: () => {
      const a = genPassword(), b = genPassword();
      assert.ok(a.length >= 20, 'long enough');
      assert.ok(/^[A-Za-z0-9_-]+$/.test(a), `url-safe; got ${a}`);
      assert.notStrictEqual(a, b, 'random per call');
    },
  },
];

module.exports = { tests };

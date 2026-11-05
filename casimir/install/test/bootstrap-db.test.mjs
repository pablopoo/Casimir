import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { loadBootstrapFixtureConfig } from './bootstrap-db-fixture.mjs';

const require = createRequire(new URL('../../../platform/packages/api/package.json', import.meta.url));
const fixture = await loadBootstrapFixtureConfig();
const checks = await import('../../dist/checks.mjs');
const { Pool } = require('pg');
const quoteIdentifier = (value) => `"${value.replaceAll('"', '""')}"`;

test('real_domain_bootstrap_is_transactional_and_never_reseeds_initialized_database', async () => {
  const adminPool = new Pool({ connectionString: fixture.adminConnectionString });
  let bootstrapPool;
  let createdByThisRun = false;
  let roleName;

  try {
    const role = await adminPool.query(
      'SELECT current_user, rolcreatedb, rolsuper FROM pg_roles WHERE rolname = current_user',
    );
    assert.equal(role.rows.length, 1, 'bootstrap fixture role must resolve on the isolated PostgreSQL server');
    roleName = role.rows[0].current_user;
    assert.equal(roleName, fixture.roleName, 'bootstrap fixture connection role must match its generated URL');
    assert.ok(role.rows[0].rolcreatedb || role.rows[0].rolsuper, 'bootstrap fixture role must be able to create a database');

    const existing = await adminPool.query('SELECT 1 FROM pg_database WHERE datname = $1', [fixture.databaseName]);
    assert.equal(existing.rowCount, 0, 'bootstrap fixture database already exists; refusing to reuse it');

    await adminPool.query(
      `CREATE DATABASE ${quoteIdentifier(fixture.databaseName)} OWNER ${quoteIdentifier(roleName)}`,
    );
    createdByThisRun = true;

    const ownership = await adminPool.query(
      'SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1',
      [fixture.databaseName],
    );
    assert.deepEqual(ownership.rows, [{ owner: roleName }], 'new bootstrap database must be owned by the fixture role');

    const migrationEnv = {
      ...process.env,
      DATABASE_URL: fixture.bootstrapConnectionString,
    };
    for (const file of ['casimir/migrate.mjs', 'casimir/mvp-a/migrate.mjs']) {
      const result = spawnSync(process.execPath, [file], { env: migrationEnv, encoding: 'utf8' });
      assert.equal(result.status, 0, `${file} failed in the synthetic database:\n${result.stderr}`);
    }

    bootstrapPool = new Pool({ connectionString: fixture.bootstrapConnectionString });
    assert.equal(typeof checks.bootstrapInstallationDatabase, 'function', 'real bootstrap contract missing');
    const db = checks.createDb(bootstrapPool);
    const installationId = '1'.repeat(32);
    const first = await checks.bootstrapInstallationDatabase(db, installationId, 'c1.0');
    assert.match(first.operatorId, /^user_/);
    assert.match(first.projectId, /^proj_/);
    const again = await checks.bootstrapInstallationDatabase(db, installationId, 'c1.0');
    assert.deepEqual(again, first);

    const rows = await bootstrapPool.query(
      'SELECT (SELECT count(*) FROM users)::int users,(SELECT count(*) FROM projects)::int projects,(SELECT count(*) FROM project_ownership_periods)::int ownership',
    );
    assert.deepEqual(rows.rows[0], { users: 1, projects: 1, ownership: 1 });
    await assert.rejects(
      () => checks.bootstrapInstallationDatabase(db, '2'.repeat(32), 'c1.0'),
      /foreign|identity/,
    );
  } finally {
    try {
      if (bootstrapPool) await bootstrapPool.end();

      if (createdByThisRun) {
        const ownership = await adminPool.query(
          'SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1',
          [fixture.databaseName],
        );
        if (ownership.rowCount !== 1 || ownership.rows[0].owner !== roleName) {
          throw new Error('bootstrap fixture ownership changed; retaining the database');
        }
        const sessions = await adminPool.query(
          'SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
          [fixture.databaseName],
        );
        if (sessions.rows[0].count !== 0) {
          throw new Error('bootstrap fixture still has active sessions; retaining the database');
        }
        await adminPool.query(`DROP DATABASE ${quoteIdentifier(fixture.databaseName)}`);
        const afterDrop = await adminPool.query('SELECT 1 FROM pg_database WHERE datname = $1', [fixture.databaseName]);
        assert.equal(afterDrop.rowCount, 0, 'created bootstrap fixture database remains after exact cleanup');
        createdByThisRun = false;
      }
    } finally {
      await adminPool.end();
    }
  }
});

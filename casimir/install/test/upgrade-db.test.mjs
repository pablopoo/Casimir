import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import * as checks from '../../dist/checks.mjs';
import { applyControlUpgrade } from '../../../platform/packages/api/src/casimir/lifecycle/upgrade.ts';
import {
  assertControlSchema,
  controlMigrationCatalog,
} from '../../../platform/packages/api/src/casimir/lifecycle/control-migrations.ts';

const require = createRequire(new URL('../../../platform/packages/api/package.json', import.meta.url));
const { Pool } = require('pg');
const replaySchemas = ['casimir_install', 'casimir_mvp_a'];

async function openReplayConnection() {
  const name = process.env.CASIMIR_C1_UPGRADE_TEST_DATABASE;
  assert.match(
    name ?? '',
    /^casimir_c1_upgrade_replay_\d{8}_[a-f0-9]{6}$/,
    'an isolated, newly created C1 replay database is required',
  );
  const line = (
    await readFile(process.env.CASIMIR_C1_TEST_ENV_FILE ?? '.local/c1/test.env', 'utf8')
  ).trim();
  const url = new URL(line.slice('DATABASE_URL='.length));
  url.pathname = `/${name}`;
  return { connectionString: url.toString(), pool: new Pool({ connectionString: url.toString() }) };
}

async function assertReplaySchemasAbsent(pool) {
  const { rows } = await pool.query(
    'SELECT nspname FROM pg_namespace WHERE nspname = ANY($1::text[]) ORDER BY nspname',
    [replaySchemas],
  );
  if (rows.length) {
    const error = new Error(`upgrade_fixture_namespace_conflict:${rows.map((row) => row.nspname).join(',')}`);
    error.code = 'upgrade_fixture_namespace_conflict';
    throw error;
  }
}

async function createOwnedSchema(pool, name, ownedSchemas) {
  await pool.query(`CREATE SCHEMA "${name}"`);
  ownedSchemas.add(name);
}

async function dropOwnedSchemas(getPool, ownedSchemas) {
  for (const name of [...ownedSchemas].reverse()) {
    await getPool().query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
    ownedSchemas.delete(name);
  }
}

async function withFreshReplaySchemas(getPool, run) {
  const ownedSchemas = new Set();
  try {
    await assertReplaySchemasAbsent(getPool());
    for (const name of replaySchemas) await createOwnedSchema(getPool(), name, ownedSchemas);
    return await run();
  } finally {
    await dropOwnedSchemas(getPool, ownedSchemas);
  }
}

test('upgrade_fixture_refuses_existing_namespaces_and_preserves_sentinel_data', async () => {
  const { pool } = await openReplayConnection();
  const testOwnedSchemas = new Set();
  try {
    await assertReplaySchemasAbsent(pool);

    // An empty preexisting namespace must fail preflight even though it has no tables.
    await createOwnedSchema(pool, 'casimir_mvp_a', testOwnedSchemas);
    await assert.rejects(
      () => withFreshReplaySchemas(() => pool, async () => assert.fail('fixture unexpectedly ran')),
      (error) => error.code === 'upgrade_fixture_namespace_conflict',
    );
    assert.deepEqual(
      (await pool.query("SELECT nspname FROM pg_namespace WHERE nspname = 'casimir_mvp_a'")).rows,
      [{ nspname: 'casimir_mvp_a' }],
    );
    await dropOwnedSchemas(() => pool, testOwnedSchemas);

    // A preexisting namespace with data must survive both the failed setup and its finally path.
    await createOwnedSchema(pool, 'casimir_install', testOwnedSchemas);
    await pool.query('CREATE TABLE casimir_install.fixture_sentinel(value text PRIMARY KEY)');
    await pool.query("INSERT INTO casimir_install.fixture_sentinel(value) VALUES('preserve-me')");
    await assert.rejects(
      () => withFreshReplaySchemas(() => pool, async () => assert.fail('fixture unexpectedly ran')),
      (error) => error.code === 'upgrade_fixture_namespace_conflict',
    );
    assert.deepEqual(
      (await pool.query('SELECT value FROM casimir_install.fixture_sentinel')).rows,
      [{ value: 'preserve-me' }],
    );
  } finally {
    try {
      await dropOwnedSchemas(() => pool, testOwnedSchemas);
    } finally {
      await pool.end();
    }
  }
});

test('committed_control_upgrade_replays_once_after_lost_acknowledgement', async () => {
  const { connectionString, pool: initialPool } = await openReplayConnection();
  let pool = initialPool;
  let guards = 0;
  try {
    await withFreshReplaySchemas(() => pool, async () => {
      await pool.query(
        'CREATE TABLE casimir_install.installation(id integer PRIMARY KEY CHECK(id=1),installation_id text NOT NULL,phase text NOT NULL,bundle_version text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now())',
      );
      await pool.query(
        "CREATE TABLE casimir_install.maintenance(id text PRIMARY KEY,installation_id text NOT NULL,kind text NOT NULL,phase text NOT NULL,source_version text NOT NULL,target_version text,inventory_hash text,last_error_code text,detail jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now())",
      );
      await pool.query(
        'CREATE TABLE casimir_install.schema_migrations(version integer PRIMARY KEY,hash text NOT NULL)',
      );
      await pool.query('CREATE TABLE casimir_mvp_a.scope(id integer PRIMARY KEY)');
      await pool.query('CREATE TABLE casimir_mvp_a.operations(id text PRIMARY KEY,phase text NOT NULL)');
      await pool.query('INSERT INTO casimir_mvp_a.scope(id) VALUES(1)');

      const catalog = await controlMigrationCatalog('c1.1');
      const installationId = randomBytes(16).toString('hex');
      const source = {
        version: 'c1.0',
        sourceRevision: 'a'.repeat(40),
        platform: 'linux/amd64',
        runtime: { runtimeId: 'r' },
        sdk: [],
        images: ['control', 'runner', 'database', 'ingress'].map((role) => ({
          role,
          imageId: role === 'control' ? 'control-old' : role,
        })),
        controlSchema: { version: 1, migrationHashes: [catalog[0].hash], readableBy: ['c1.0'] },
        upgradeFrom: [],
      };
      const target = structuredClone(source);
      target.version = 'c1.1';
      target.sourceRevision = 'b'.repeat(40);
      target.images[0].imageId = 'control-new';
      target.controlSchema = {
        version: 2,
        migrationHashes: catalog.map((migration) => migration.hash),
        readableBy: ['c1.1'],
      };
      target.upgradeFrom = ['c1.0'];
      const intent = {
        format: 1,
        id: randomBytes(16).toString('hex'),
        installationId,
        source,
        target,
        sourceHash: randomBytes(32).toString('hex'),
        targetHash: randomBytes(32).toString('hex'),
        backupRecordId: randomBytes(16).toString('hex'),
        backupHash: randomBytes(32).toString('hex'),
      };

      await pool.query('INSERT INTO casimir_install.schema_migrations(version,hash) VALUES(1,$1)', [
        catalog[0].hash,
      ]);
      await pool.query(
        "INSERT INTO casimir_install.installation(id,installation_id,phase,bundle_version) VALUES(1,$1,'maintenance','c1.0')",
        [installationId],
      );
      await pool.query(
        "INSERT INTO casimir_install.maintenance(id,installation_id,kind,phase,source_version,inventory_hash) VALUES($1,$2,'backup','verified','c1.0',$3)",
        [intent.backupRecordId, installationId, intent.backupHash],
      );

      const first = await applyControlUpgrade(checks.createDb(pool), intent, () => guards++);
      assert.equal(first.phase, 'migrated');
      await pool.end();

      // A new pool represents a fresh operator process after COMMIT but before its acknowledgement.
      pool = new Pool({ connectionString });
      const committed = await pool.query(
        'SELECT bundle_version,phase FROM casimir_install.installation WHERE id=1 AND installation_id=$1',
        [installationId],
      );
      assert.deepEqual(committed.rows[0], { bundle_version: 'c1.1', phase: 'maintenance' });
      const db = checks.createDb(pool);
      const retry = await applyControlUpgrade(db, intent, () => guards++);
      assert.equal(retry.phase, 'migrated');
      await assertControlSchema(db, 'c1.1');
      await assert.rejects(() => assertControlSchema(db, 'c1.0'), /lifecycle_schema_mismatch/);
      await assert.rejects(
        () => applyControlUpgrade(db, { ...intent, targetHash: 'd'.repeat(64) }, () => {}),
        /upgrade_intent_conflict/,
      );
      const migrations = await pool.query(
        'SELECT count(*)::int count FROM casimir_install.schema_migrations WHERE version=2',
      );
      const probe = await pool.query(
        'SELECT applied_count FROM casimir_install.upgrade_probe WHERE id=1',
      );
      assert.equal(migrations.rows[0].count, 1);
      assert.equal(probe.rows[0].applied_count, 1);
      assert.ok(guards >= 4);
    });
  } finally {
    await pool.end();
  }
});
